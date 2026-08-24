import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { ISpace, IIdentity } from '../core/types';
import { buildSshCommand } from './repoBinding';
import { slugify } from '../core/identity';

const execFileAsync = promisify(execFile);

/** Reads the global Git user.name and user.email. */
export async function getGitUser(): Promise<{ userName: string; email: string }> {
  const { stdout: userNameOutput } = await execFileAsync('git', ['config', '--global', 'user.name']);
  const { stdout: emailOutput } = await execFileAsync('git', ['config', '--global', 'user.email']);
  return { userName: userNameOutput.trim(), email: emailOutput.trim() };
}

// ---------------------------------------------------------------------------
// includeIf-first global identity
//
// DSS no longer writes user.name/user.email (and now core.sshCommand)
// directly into the user's ~/.gitconfig on every switch. Instead it writes
// them into a single DSS-managed file (active.gitconfig) and makes sure the
// user's global config includes it. Switching identities becomes "rewrite
// one small file" instead of "mutate the user's own gitconfig in place".
// ---------------------------------------------------------------------------

/** Absolute path to the DSS-managed gitconfig the user's global config includes. */
export function activeGitconfigPath(): string {
  return path.join(os.homedir(), '.dss', 'active.gitconfig');
}

/** Absolute path to the per-identity gitconfig a directory rule's
 * `includeIf` points at (~/.dss/identities/<slug>.gitconfig). */
export function identityGitconfigPath(identityName: string): string {
  return path.join(os.homedir(), '.dss', 'identities', `${slugify(identityName)}.gitconfig`);
}

export function quoteGitConfigValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * A raw `\n`/`\r` in a value that's about to be interpolated into a
 * double-quoted single-line gitconfig value would either break the file's
 * line structure (breaking every git invocation that reads it, since these
 * files are unconditionally or conditionally included) or, worse, splice
 * attacker-controlled config lines into a global, always-included file
 * (e.g. an email ending in `"\n[core]\n\tsshCommand = ..."` — arbitrary
 * command execution the next time git shells out over SSH). This is the
 * hard gate: no path may ever reach the writer with a newline/carriage
 * return in a value that ends up in the file, regardless of what prompt
 * validation callers do or don't have upstream.
 */
function assertNoNewline(target: string, label: string, value: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(
      `Refusing to write ${target}: ${label} contains a line break, ` +
      'which could corrupt or inject into this config file.'
    );
  }
}

interface GitconfigIdentityValues {
  userName: string;
  email: string;
  sshKeyPath?: string;
}

/**
 * Renders the `[user]` (+ optional `[core] sshCommand`) content shared by
 * active.gitconfig and every per-identity gitconfig — the section-rendering
 * guts writeActiveGitconfig and writeIdentityGitconfig both defer to, so the
 * two file shapes can never drift from each other.
 */
function renderIdentityGitconfig(target: string, values: GitconfigIdentityValues): string {
  assertNoNewline(target, 'userName', values.userName);
  assertNoNewline(target, 'email', values.email);
  if (values.sshKeyPath) {
    assertNoNewline(target, 'sshKeyPath', values.sshKeyPath);
  }

  const lines = [
    '[user]',
    `\tname = ${quoteGitConfigValue(values.userName)}`,
    `\temail = ${quoteGitConfigValue(values.email)}`
  ];
  if (values.sshKeyPath) {
    lines.push('[core]', `\tsshCommand = ${quoteGitConfigValue(buildSshCommand(values.sshKeyPath))}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Atomically writes `content` to `configPath` (ensureDir + tmp-file + move-overwrite). */
async function atomicWriteFile(configPath: string, content: string): Promise<void> {
  await fs.ensureDir(path.dirname(configPath));
  const tmpPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, content);
  await fs.move(tmpPath, configPath, { overwrite: true });
}

/**
 * Atomically writes active.gitconfig for `space`: a `[user]` section
 * (name/email) plus — only when the identity has a key — a `[core]
 * sshCommand` built the same way a repo-local binding's is (via
 * buildSshCommand, shared with src/infra/repoBinding.ts). A keyless identity
 * gets a `[user]`-only file.
 */
export async function writeActiveGitconfig(space: ISpace): Promise<void> {
  const configPath = activeGitconfigPath();
  const content = renderIdentityGitconfig('active.gitconfig', space);
  await atomicWriteFile(configPath, content);
}

/**
 * Atomically writes `~/.dss/identities/<slug>.gitconfig` for `identity` —
 * same [user]/[core] shape as active.gitconfig (via the same
 * renderIdentityGitconfig helper), but named for a directory rule's
 * `includeIf` to point at rather than the global include. Written/refreshed
 * on `dss rule add` for the ruled identity, and re-applied whenever an
 * identity with existing rules is edited (see spaces.ts's modifySpace).
 */
export async function writeIdentityGitconfig(identity: IIdentity): Promise<void> {
  const configPath = identityGitconfigPath(identity.name);
  const content = renderIdentityGitconfig(`${slugify(identity.name)}.gitconfig`, {
    userName: identity.userName,
    email: identity.email,
    sshKeyPath: identity.key?.path
  });
  await atomicWriteFile(configPath, content);
}

/**
 * Ensures the user's global Git config includes `configPath`, adding it
 * exactly once (idempotent — never a duplicate `include.path` entry).
 * Generalized over both DSS-managed includes: active.gitconfig (the global
 * switch) and rules.gitconfig (directory rules) each call this with their
 * own path.
 *
 * ORDERING: git applies conditional includes in file order, so
 * rules.gitconfig's `includeIf` sections only override active.gitconfig's
 * unconditional `[user]` inside a ruled directory when rules.gitconfig's
 * `include.path` entry comes AFTER active.gitconfig's in ~/.gitconfig.
 * Since this function only ever APPENDS a missing entry (never reorders
 * existing ones), the normal call order — `dss new`/`dss use` adding
 * active.gitconfig's include before any `dss rule add` adds rules.gitconfig's
 * — produces the correct order for free. KNOWN CAVEAT: if `dss rule add` is
 * run before active.gitconfig's include has ever been added (no identity
 * has been switched to yet), or if the user hand-edits ~/.gitconfig and
 * flips the two entries' order, directory rules will NOT override the
 * global default as expected — `dss doctor` surfaces drift against the
 * ruled identity, but doesn't fix mis-ordered entries a user's own file put
 * there.
 *
 * KNOWN CAVEAT (unchanged from before generalization): git applies config
 * in file order, so a `[user]` section that appears AFTER the include line
 * in the user's own ~/.gitconfig still wins over the values in an included
 * file. DSS can't fix a user's own file ordering here; `dss doctor` detects
 * and flags that case.
 */
export async function ensureGlobalInclude(configPath: string): Promise<void> {
  let includes: string[] = [];
  try {
    const { stdout } = await execFileAsync('git', ['config', '--global', '--get-all', 'include.path']);
    includes = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  } catch (error) {
    // Exit code 1 means the key is simply unset — treat as "no includes yet".
    if ((error as { code?: unknown }).code !== 1) throw error;
  }

  if (includes.includes(configPath)) return;
  await execFileAsync('git', ['config', '--global', '--add', 'include.path', configPath]);
}
