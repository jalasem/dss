import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs-extra';
import path from 'path';
import { gitEnvironment } from './repoBinding';

const execFileAsync = promisify(execFile);

/** Short form of the marker, for error/status MESSAGES only (e.g.
 * "missing ..."). NOT used for detection — see MARKER_LINE/isDssHook below,
 * a bare substring match on this would misidentify a foreign hook that
 * merely mentions this text (e.g. inside an unrelated echo/comment) as
 * DSS-owned. */
export const HOOK_MARKER = '# dss-guard v1';

const SHEBANG_LINE = '#!/bin/sh';

/** The exact marker comment LINE every DSS-installed pre-commit hook
 * carries as its second line. Detection (isDssHook) requires this exact
 * line — not merely text appearing somewhere in the file — so a foreign
 * hook can never be misidentified as DSS-owned just by mentioning the
 * marker text in passing. */
const MARKER_LINE = `${HOOK_MARKER} — installed by \`dss guard install\`; remove with \`dss guard uninstall\``;

/**
 * The exact pre-commit hook script `dss guard install` writes (brief §3):
 * a `command -v dss` guard line FIRST, so a repo cloned onto a machine
 * without `dss` on PATH never bricks `git commit` — the hook silently
 * no-ops (exit 0) instead of failing every commit with "command not found".
 */
export const HOOK_SCRIPT = `${SHEBANG_LINE}
${MARKER_LINE}
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

/**
 * Whether `content` is a hook DSS wrote — the only thing that
 * distinguishes a hook DSS wrote from one it must never touch (overwrite
 * on install, delete on uninstall). Anchored to the exact FIRST TWO lines
 * (shebang, then the marker comment) matching, byte-for-byte (after outer
 * whitespace trim), what `writeHook` always writes — deliberately NOT a
 * substring search anywhere in the file, which would misidentify a
 * foreign hook as DSS-owned merely for mentioning the marker text in an
 * unrelated echo/comment (a real, live-reproduced bug: such a hook was
 * silently overwritten by `install` and would have been deleted by
 * `uninstall`). Content after line 2 is intentionally not checked, so a
 * hand-edited-but-still-DSS-installed hook (extra lines appended below the
 * marker) is still recognized as DSS's own.
 */
export function isDssHook(content: string): boolean {
  const lines = content.split('\n');
  return lines[0]?.trim() === SHEBANG_LINE && lines[1]?.trim() === MARKER_LINE;
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
