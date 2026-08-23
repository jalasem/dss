import { execFile } from "child_process";
import { promisify } from 'util';
import os from "os";
import fs from "fs-extra";
import path from "path";
// LAYER VIOLATION (flagged, not fixed — see task-2-report.md "Concerns"):
// these functions print via UIHelper/fail on success/failure paths that are
// interleaved with control flow in their callers (e.g. switchSpace keeps
// going after a failed setHostSSHKey/removeSSHKeyFromAgent because these
// call fail() internally instead of throwing). Inverting to "throw/return,
// print in the command layer" would change that control flow, which the
// brief says to avoid — so the UIHelper/fail imports stay here.
import { UIHelper } from "../commands/ui";
import { safeConfirm } from "../commands/prompts";
import { fail } from "../commands/fail";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// ssh-config parsing: parse-don't-splice
// ---------------------------------------------------------------------------

export interface SshConfigBlock {
  keyword: 'Host' | 'Match';
  /** Pattern tokens after the keyword (empty for Match blocks). */
  patterns: string[];
  /** The exact original "Host ..."/"Match ..." line, unmodified. */
  headerLine: string;
  /** Raw body lines belonging to this block (comments, directives, blank lines), unmodified unless this is the target block being updated. */
  lines: string[];
}

export interface ParsedSshConfig {
  /** Raw lines before the first Host/Match directive. */
  preamble: string[];
  blocks: SshConfigBlock[];
}

const HOST_OR_MATCH_LINE = /^\s*(Host|Match)\s+(.*)$/i;

/**
 * Parses an ssh_config file into an ordered preamble + Host/Match block
 * list, keeping every line's exact original text so untouched content can
 * be reproduced byte-for-byte by `serialize`.
 */
export function parseSshConfig(content: string): ParsedSshConfig {
  const lines = content.split('\n');
  const preamble: string[] = [];
  const blocks: SshConfigBlock[] = [];
  let current: SshConfigBlock | null = null;

  for (const line of lines) {
    const match = line.match(HOST_OR_MATCH_LINE);
    if (match) {
      if (current) blocks.push(current);
      const keyword: 'Host' | 'Match' = match[1].toLowerCase() === 'host' ? 'Host' : 'Match';
      const patterns = keyword === 'Host' ? match[2].trim().split(/\s+/).filter(Boolean) : [];
      current = { keyword, patterns, headerLine: line, lines: [] };
    } else if (current) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (current) blocks.push(current);

  return { preamble, blocks };
}

/** Reproduces a ParsedSshConfig back into ssh_config text. Round-trips byte-for-byte when nothing was changed. */
export function serialize(parsed: ParsedSshConfig): string {
  const parts: string[] = [...parsed.preamble];
  for (const block of parsed.blocks) {
    parts.push(block.headerLine, ...block.lines);
  }
  return parts.join('\n');
}

const MANAGED_DIRECTIVES = ['HostName', 'User', 'IdentityFile', 'IdentitiesOnly'] as const;

function directiveLine(name: string, value: string): string {
  return `  ${name} ${value}`;
}

function upsertDirective(lines: string[], name: string, value: string): string[] {
  const re = new RegExp(`^\\s*${name}\\b`, 'i');
  const idx = lines.findIndex((line) => re.test(line));
  const formatted = directiveLine(name, value);
  if (idx === -1) return [...lines, formatted];
  const updated = [...lines];
  updated[idx] = formatted;
  return updated;
}

// ssh_config reads an unquoted value up to the first whitespace, so a key
// directory containing a space (migrated v1 users can have one) would
// silently truncate the IdentityFile path unless it's quoted.
function formatIdentityFileValue(sshKeyPath: string): string {
  return /\s/.test(sshKeyPath) ? `"${sshKeyPath}"` : sshKeyPath;
}

/**
 * A raw `\r`/`\n` in `host` or `sshKeyPath` reaching the serializer could
 * inject an arbitrary extra ssh_config line (e.g. a `host` of
 * "github.com\n  ProxyCommand /bin/sh -c ...") — this is the hard gate: no
 * value may ever reach the writer with a line break, regardless of what
 * validation callers (import filters, prompts) do or don't have upstream.
 */
function assertSshConfigSafe(label: string, value: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(
      `Refusing to update SSH config: ${label} contains a line break, ` +
      'which could inject an arbitrary ssh_config directive.'
    );
  }
}

function buildManagedBlockLines(existingLines: string[], sshKeyPath: string, host: string): string[] {
  const values: Record<typeof MANAGED_DIRECTIVES[number], string> = {
    HostName: host,
    User: 'git',
    IdentityFile: formatIdentityFileValue(sshKeyPath),
    IdentitiesOnly: 'yes'
  };
  let lines = existingLines;
  for (const directive of MANAGED_DIRECTIVES) {
    lines = upsertDirective(lines, directive, values[directive]);
  }
  return lines;
}

/**
 * Applies the "HostName/User/IdentityFile/IdentitiesOnly" managed lines for
 * `host`, targeting ONLY a `Host` block whose pattern list is exactly the
 * single literal `host` (never a multi-pattern list like "Host a b", never
 * `github.com-work`, never a Match block). All other lines in that block
 * (ProxyJump, Port, comments, ...) and every other block are left
 * byte-identical. When no such block exists, a new one is appended at the
 * end (old splice-created "Host github.com" blocks match exactly and are
 * adopted in place instead of duplicated).
 */
export function applyHostSSHKey(content: string, sshKeyPath: string, host: string): string {
  assertSshConfigSafe('host', host);
  assertSshConfigSafe('sshKeyPath', sshKeyPath);

  const parsed = parseSshConfig(content);
  const targetIndex = parsed.blocks.findIndex(
    (block) => block.keyword === 'Host' && block.patterns.length === 1 && block.patterns[0] === host
  );

  if (targetIndex !== -1) {
    const target = parsed.blocks[targetIndex];
    const updatedLines = buildManagedBlockLines(target.lines, sshKeyPath, host);
    const blocks = [...parsed.blocks];
    blocks[targetIndex] = { ...target, lines: updatedLines };
    return serialize({ preamble: parsed.preamble, blocks });
  }

  const newBlockText = [`Host ${host}`, ...buildManagedBlockLines([], sshKeyPath, host)].join('\n');
  const existing = serialize(parsed);
  const trimmedExisting = existing.replace(/\s+$/, '');
  return trimmedExisting === '' ? newBlockText : `${trimmedExisting}\n\n${newBlockText}`;
}

/**
 * Updates (or creates) the SSH config block for `host` to point at
 * `sshKeyPath`, via parse-don't-splice: reads the existing config, parses it
 * into blocks, and only rewrites the four managed lines of the matching
 * `Host <host>` block (or appends a new one), leaving everything else —
 * comments, ProxyJump/Port lines, other hosts, indentation — untouched.
 * Writes only when the content actually changed, taking a single rolling
 * backup at `~/.ssh/config.dss.bak` (overwritten each time) immediately
 * before every write. A freshly-created config file is chmod'd 600; an
 * existing file's permissions are left as-is.
 */
export async function setHostSSHKey(sshKeyPath: string, host: string): Promise<void> {
  const sshConfigPath = path.join(os.homedir(), '.ssh', 'config');
  const backupPath = `${sshConfigPath}.dss.bak`;

  try {
    const existedBefore = await fs.pathExists(sshConfigPath);
    await fs.ensureFile(sshConfigPath);
    if (!existedBefore) {
      await fs.chmod(sshConfigPath, 0o600);
    }

    const original = await fs.readFile(sshConfigPath, 'utf8');
    const updated = applyHostSSHKey(original, sshKeyPath, host);

    if (updated === original) {
      return;
    }

    await fs.copy(sshConfigPath, backupPath, { overwrite: true });
    await fs.writeFile(sshConfigPath, updated);
    UIHelper.success(`SSH config for ${host} updated successfully.`);
  } catch (error) {
    fail(`Failed to update SSH config for ${host}: ` + (error as Error).message);
  }
}

/** Result of the cheap, local-only agent fingerprint check. */
export interface AgentKeyCheck {
  fingerprint?: string;
  loaded: boolean;
  /** false when the fingerprint/agent probe itself failed (e.g. no agent
   * running, ssh-keygen unavailable) — render as "unable to check" rather
   * than a false "not loaded". */
  checked: boolean;
}

/**
 * Cheap, local-only check for whether the key at `publicKeyPath` is
 * currently loaded in the ssh-agent: extracts its fingerprint via
 * `ssh-keygen -lf` and compares it against `ssh-add -l` output. No network
 * calls — safe for the bare-`dss` dashboard's fast path as well as `dss
 * doctor`. Extracted from the inspect/test flows' inline duplicate of this
 * logic so both share one implementation.
 */
export async function checkKeyLoadedInAgent(publicKeyPath: string): Promise<AgentKeyCheck> {
  try {
    const { stdout: fingerprintOutput } = await execFileAsync('ssh-keygen', ['-lf', publicKeyPath]);
    const fingerprint = fingerprintOutput.match(/SHA256:\S+/)?.[0];
    const { stdout: agentOutput } = await execFileAsync('ssh-add', ['-l']);
    const loaded = Boolean(fingerprint) && agentOutput.includes(fingerprint as string);
    return { fingerprint, loaded, checked: true };
  } catch {
    return { loaded: false, checked: false };
  }
}

/** Result of matching an identity's key against ~/.ssh/config's `Host <host>` block. */
export type SshConfigCheck = 'match' | 'points-elsewhere' | 'absent';

/**
 * Checks whether ~/.ssh/config has a single-pattern `Host <host>` block
 * (the same shape applyHostSSHKey manages) whose IdentityFile points at
 * `sshKeyPath`. Reuses the parse-don't-splice reader so this stays in sync
 * with what `dss use`/`dss key rotate` actually write.
 */
export async function checkSshConfigHost(host: string, sshKeyPath: string): Promise<SshConfigCheck> {
  const sshConfigPath = path.join(os.homedir(), '.ssh', 'config');
  if (!(await fs.pathExists(sshConfigPath))) return 'absent';

  const content = await fs.readFile(sshConfigPath, 'utf8');
  const parsed = parseSshConfig(content);
  const block = parsed.blocks.find(
    (candidate) => candidate.keyword === 'Host' && candidate.patterns.length === 1 && candidate.patterns[0] === host
  );
  if (!block) return 'absent';

  const identityLine = block.lines.find((line) => /^\s*IdentityFile\b/i.test(line));
  if (!identityLine) return 'points-elsewhere';

  const value = identityLine.replace(/^\s*IdentityFile\s+/i, '').trim().replace(/^"(.*)"$/, '$1');
  return value === sshKeyPath ? 'match' : 'points-elsewhere';
}

// ---------------------------------------------------------------------------
// ssh-agent
// ---------------------------------------------------------------------------

/**
 * Adds a key to the ssh-agent. On macOS, prefers `--apple-use-keychain` so
 * the passphrase persists in the login keychain across reboots, falling
 * back to a plain `ssh-add` if the flag itself errors (e.g. an older
 * ssh-add build that doesn't support it).
 */
export async function addToAgent(keyPath: string): Promise<void> {
  if (process.platform === 'darwin') {
    try {
      await execFileAsync('ssh-add', ['--apple-use-keychain', keyPath]);
      return;
    } catch {
      // fall through to plain ssh-add
    }
  }
  await execFileAsync('ssh-add', [keyPath]);
}

export async function removeSSHKeyFromAgent(sshKeyPath: string): Promise<void> {
  try {
    await execFileAsync('ssh-add', ['-d', sshKeyPath]);
    UIHelper.success("SSH key removed from ssh-agent successfully.");
  } catch (error) {
    fail("Error removing SSH key from ssh-agent: " + (error as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Host access test
// ---------------------------------------------------------------------------

// Substrings a host's SSH banner uses to confirm authentication even though
// the "ssh -T" command itself exits non-zero (none of these hosts grant
// shell access over SSH, so a non-zero exit is the expected happy path).
const SUCCESS_MARKERS = [
  'successfully authenticated', // GitHub
  'Welcome to GitLab',          // GitLab
  'logged in as',                // Bitbucket
  'authenticated via'            // Bitbucket
];

/** Result of the pure, non-interactive host-auth check. */
export interface HostAccessCheck {
  ok: boolean;
  detail: string;
}

/**
 * PURE, non-interactive SSH host-auth check: runs `ssh -i <path> -o
 * IdentitiesOnly=yes -T git@<host>` and applies the same exit-0/success-
 * marker detection `testHostAccess` uses, but never prompts and never
 * prints. Safe to call from a script-facing command (`dss doctor`) that
 * must never block on stdin — unlike `testHostAccess`, which is the
 * interactive flow built on top of this (header + success/failure message
 * + the "show public key?" prompt, still used by the deprecated `test`
 * alias and the post-switch "test access?" prompt).
 */
export async function checkHostAccess(sshKeyPath: string, host: string): Promise<HostAccessCheck> {
  try {
    await execFileAsync('ssh', ['-i', sshKeyPath, '-o', 'IdentitiesOnly=yes', '-T', `git@${host}`]);
    return { ok: true, detail: `Successfully authenticated with ${host}.` };
  } catch (error) {
    const { stderr, stdout } = error as { stderr?: string; stdout?: string };
    const output = `${stderr ?? ''}${stdout ?? ''}`;
    if (SUCCESS_MARKERS.some((marker) => output.includes(marker))) {
      return { ok: true, detail: `Successfully authenticated with ${host}.` };
    }
    return { ok: false, detail: (error as Error).message };
  }
}

/**
 * Tests SSH access to `host` using `sshKeyPath` specifically, via
 * `-i <path> -o IdentitiesOnly=yes`. This is key-specific and no longer
 * depends on the ssh-agent or ssh-config being set up for the space, so
 * (unlike the old testGithubAccess) it does NOT ssh-add the key first.
 * The interactive flow (header, success/failure message, "show public
 * key?" prompt) built on top of the pure `checkHostAccess` check — kept
 * for the deprecated `test` alias and the post-switch access-test prompt.
 * `dss doctor` calls `checkHostAccess` directly instead: it must never
 * prompt (this always asks to show the public key, which would hang a
 * script/CI invocation of doctor waiting on stdin).
 */
export async function testHostAccess(sshKeyPath: string, host: string): Promise<void> {
  UIHelper.printHeader(`Testing SSH Access to ${host}`);

  try {
    const result = await checkHostAccess(sshKeyPath, host);
    if (result.ok) {
      UIHelper.success(`Space configuration works! You've successfully authenticated with ${host}.`);
    } else {
      fail(`Error testing SSH access to ${host}: ` + result.detail);
    }

    const showPublicKey = await safeConfirm({
      message: "Would you like to see the public SSH key?",
      default: false,
    });

    if (!showPublicKey) return;
    const publicKeyPath = `${sshKeyPath}.pub`;
    const publicKey = await fs.readFile(publicKeyPath, 'utf8');
    console.log(UIHelper.dim("\nPublic SSH Key:"));
    console.log(UIHelper.highlight(publicKey));
  } catch (error) {
    fail(`Error testing SSH access to ${host}: ` + (error as Error).message);
    UIHelper.info(`Ensure the public key has been added to your ${host} account.`);
  }
}
