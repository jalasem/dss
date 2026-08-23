import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { ISpace } from '../core/types';
import { buildSshCommand } from './repoBinding';

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

function quoteGitConfigValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * A raw `\n`/`\r` in a value that's about to be interpolated into a
 * double-quoted single-line gitconfig value would either break the file's
 * line structure (breaking every git invocation that reads it, since
 * active.gitconfig is unconditionally included) or, worse, splice
 * attacker-controlled config lines into a global, always-included file
 * (e.g. an email ending in `"\n[core]\n\tsshCommand = ..."` — arbitrary
 * command execution the next time git shells out over SSH). This is the
 * hard gate: no path may ever reach the writer with a newline/carriage
 * return in a value that ends up in the file, regardless of what prompt
 * validation callers do or don't have upstream.
 */
function assertNoNewline(label: string, value: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(
      `Refusing to write active.gitconfig: ${label} contains a line break, ` +
      'which could corrupt or inject into this globally-included config file.'
    );
  }
}

/**
 * Atomically writes active.gitconfig for `space`: a `[user]` section
 * (name/email) plus — only when the identity has a key — a `[core]
 * sshCommand` built the same way a repo-local binding's is (via
 * buildSshCommand, shared with src/infra/repoBinding.ts). A keyless identity
 * gets a `[user]`-only file.
 */
export async function writeActiveGitconfig(space: ISpace): Promise<void> {
  assertNoNewline('userName', space.userName);
  assertNoNewline('email', space.email);
  if (space.sshKeyPath) {
    assertNoNewline('sshKeyPath', space.sshKeyPath);
  }

  const configPath = activeGitconfigPath();
  const lines = [
    '[user]',
    `\tname = ${quoteGitConfigValue(space.userName)}`,
    `\temail = ${quoteGitConfigValue(space.email)}`
  ];
  if (space.sshKeyPath) {
    lines.push('[core]', `\tsshCommand = ${quoteGitConfigValue(buildSshCommand(space.sshKeyPath))}`);
  }
  const content = `${lines.join('\n')}\n`;

  await fs.ensureDir(path.dirname(configPath));
  const tmpPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, content);
  await fs.move(tmpPath, configPath, { overwrite: true });
}

/**
 * Ensures the user's global Git config includes active.gitconfig, adding it
 * exactly once (idempotent — never a duplicate `include.path` entry).
 *
 * KNOWN CAVEAT: Git applies config in file order, so a `[user]` section that
 * appears AFTER the include line in the user's own ~/.gitconfig still wins
 * over the values in active.gitconfig. DSS can't fix a user's own file
 * ordering here; Phase 3's `doctor` command will detect and flag that case.
 */
export async function ensureGlobalInclude(): Promise<void> {
  const configPath = activeGitconfigPath();
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
