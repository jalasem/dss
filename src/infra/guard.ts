import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs-extra';
import path from 'path';
import { gitEnvironment } from './repoBinding';

const execFileAsync = promisify(execFile);

/** The comment line every DSS-installed pre-commit hook carries — the sole
 * signal used to tell a DSS-written hook apart from a foreign one someone
 * else installed. Never overwrite/remove a hook that lacks it. */
export const HOOK_MARKER = '# dss-guard v1';

/**
 * The exact pre-commit hook script `dss guard install` writes (brief §3):
 * a `command -v dss` guard line FIRST, so a repo cloned onto a machine
 * without `dss` on PATH never bricks `git commit` — the hook silently
 * no-ops (exit 0) instead of failing every commit with "command not found".
 */
export const HOOK_SCRIPT = `#!/bin/sh
${HOOK_MARKER} — installed by \`dss guard install\`; remove with \`dss guard uninstall\`
command -v dss >/dev/null 2>&1 || exit 0
dss guard check --quiet || exit 1
`;

/**
 * Resolves the worktree-safe absolute path to this repository's pre-commit
 * hook via `git rev-parse --git-path hooks/pre-commit` — hooks live in the
 * shared Git "common dir", so this resolves correctly even from a linked
 * worktree, unlike a hardcoded `<repo>/.git/hooks/pre-commit` join (which
 * would be wrong — or not even a directory — from a worktree). Throws when
 * `cwd` is not inside a Git repository.
 */
export async function resolveHookPath(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', cwd, 'rev-parse', '--git-path', 'hooks/pre-commit'],
    { encoding: 'utf8', env: gitEnvironment() }
  );
  return path.resolve(cwd, stdout.trim());
}

/** Reads the hook file at `hookPath`, or `undefined` if none exists. */
export async function readExistingHook(hookPath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(hookPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Whether `content` carries the DSS marker comment — the only thing that
 * distinguishes a hook DSS wrote from one it must never touch. */
export function isDssHook(content: string): boolean {
  return content.includes(HOOK_MARKER);
}

/** Atomically writes the guard hook to `hookPath` and marks it executable
 * (0755) — `fs.writeFile`'s own `mode` option only takes effect when the
 * file doesn't already exist, so an explicit `chmod` afterward is what
 * guarantees 0755 on both a fresh install and a reinstall over an existing
 * (dss-marked) hook. */
export async function writeHook(hookPath: string): Promise<void> {
  await fs.ensureDir(path.dirname(hookPath));
  await fs.writeFile(hookPath, HOOK_SCRIPT, { mode: 0o755 });
  await fs.chmod(hookPath, 0o755);
}

/** Removes the hook file at `hookPath`. Caller is responsible for having
 * already confirmed (via isDssHook) that it's safe to remove. */
export async function removeHook(hookPath: string): Promise<void> {
  await fs.remove(hookPath);
}
