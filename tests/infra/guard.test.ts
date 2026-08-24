import { execFileSync } from 'child_process';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import {
  HOOK_MARKER,
  HOOK_SCRIPT,
  resolveHookPath,
  readExistingHook,
  isDssHook,
  writeHook,
  removeHook
} from '../../src/infra/guard';

function runGit(cwd: string, args: string[]): string {
  const output = execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return output.endsWith('\n') ? output.slice(0, -1) : output;
}

describe('infra/guard', () => {
  const temporaryDirectories: string[] = [];

  async function createTemporaryRepo(): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-guard-infra-'));
    temporaryDirectories.push(directory);
    const realDirectory = await fs.realpath(directory);
    runGit(realDirectory, ['init', '--quiet']);
    return realDirectory;
  }

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => fs.remove(directory)));
  });

  describe('HOOK_SCRIPT (the exact shape from the brief)', () => {
    it('starts with a #!/bin/sh shebang', () => {
      expect(HOOK_SCRIPT.startsWith('#!/bin/sh\n')).toBe(true);
    });

    it('carries the dss-guard v1 marker comment', () => {
      expect(HOOK_SCRIPT).toContain(HOOK_MARKER);
      expect(isDssHook(HOOK_SCRIPT)).toBe(true);
    });

    // Load-bearing (brief §3): without this line, a repo cloned onto a
    // machine with no `dss` on PATH would brick every commit instead of
    // silently no-opping.
    it('guards the "dss" invocation with a command -v check BEFORE calling it, so a missing dss never bricks commits', () => {
      const lines = HOOK_SCRIPT.trim().split('\n');
      const guardIndex = lines.findIndex(line => line.includes('command -v dss') && line.includes('exit 0'));
      const checkIndex = lines.findIndex(line => line.startsWith('dss guard check'));

      expect(guardIndex).toBeGreaterThan(-1);
      expect(checkIndex).toBeGreaterThan(-1);
      expect(guardIndex).toBeLessThan(checkIndex);
    });

    it('runs "dss guard check --quiet" and blocks the commit (exit 1) on failure', () => {
      expect(HOOK_SCRIPT).toContain('dss guard check --quiet || exit 1');
    });
  });

  describe('isDssHook', () => {
    it('is true for the exact HOOK_SCRIPT content DSS itself writes', () => {
      expect(isDssHook(HOOK_SCRIPT)).toBe(true);
    });

    it('is true even with extra content appended after the marker line (only the first two lines are checked)', () => {
      expect(isDssHook(`${HOOK_SCRIPT}\n# a hand-added extra line\necho extra\n`)).toBe(true);
    });

    it('is false for a foreign hook without the marker at all', () => {
      expect(isDssHook('#!/bin/sh\necho "some other tool\'s hook"\n')).toBe(false);
    });

    // Regression case for a live-reproduced bug: the previous implementation
    // was a bare `content.includes(HOOK_MARKER)` substring search, which
    // misidentified ANY hook that merely mentions the marker text anywhere
    // (e.g. inside an echo string or an unrelated comment) as DSS-owned —
    // `dss guard install` then silently OVERWROTE such a foreign hook
    // (exit 0, file clobbered), and `dss guard uninstall` would have
    // deleted it, both violating the brief's hard rule against ever
    // touching a hook DSS didn't write. Detection must be anchored to the
    // exact marker LINE, in the exact position (line 2, after the exact
    // shebang) DSS's own writeHook always produces — not "the text appears
    // somewhere in the file".
    it('is false when the marker text merely appears embedded in an unrelated line (the live-reproduced bug)', () => {
      const foreignHookMentioningMarkerText = [
        '#!/bin/sh',
        `echo "note: unrelated to ${HOOK_MARKER} - do not confuse the two"`,
        'some-other-tools-pre-commit-check --strict'
      ].join('\n');

      expect(isDssHook(foreignHookMentioningMarkerText)).toBe(false);
    });

    it('is false when only the shebang matches but the marker line is altered/missing', () => {
      expect(isDssHook('#!/bin/sh\n# dss-guard v1 (hand-edited, not the real marker line)\necho hi\n')).toBe(false);
    });

    it('is false when the marker line is exactly right but the shebang differs', () => {
      const withDifferentShebang = HOOK_SCRIPT.replace('#!/bin/sh', '#!/usr/bin/env bash');
      expect(isDssHook(withDifferentShebang)).toBe(false);
    });
  });

  describe('resolveHookPath', () => {
    it('resolves to <repo>/.git/hooks/pre-commit for a normal (non-worktree) repository', async () => {
      const repo = await createTemporaryRepo();

      const hookPath = await resolveHookPath(repo);

      expect(hookPath).toBe(path.join(repo, '.git', 'hooks', 'pre-commit'));
    });

    it('resolves to the SHARED common-dir hooks path from inside a linked worktree (worktree-safe)', async () => {
      const repo = await createTemporaryRepo();
      await fs.outputFile(path.join(repo, 'file.txt'), 'content');
      runGit(repo, ['add', 'file.txt']);
      runGit(repo, ['-c', 'user.email=a@b.com', '-c', 'user.name=A', 'commit', '-m', 'initial']);
      const worktreeDir = path.join(path.dirname(repo), `${path.basename(repo)}-worktree`);
      runGit(repo, ['worktree', 'add', worktreeDir]);
      temporaryDirectories.push(worktreeDir);

      const hookPathFromMain = await resolveHookPath(repo);
      const hookPathFromWorktree = await resolveHookPath(worktreeDir);

      // Hooks live in the shared .git dir, not a per-worktree private dir —
      // both resolve to the SAME path.
      expect(hookPathFromWorktree).toBe(hookPathFromMain);
      expect(hookPathFromWorktree).toBe(path.join(repo, '.git', 'hooks', 'pre-commit'));
    });

    it('throws when cwd is not inside a Git repository', async () => {
      const notARepo = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-guard-not-a-repo-'));
      temporaryDirectories.push(notARepo);

      await expect(resolveHookPath(notARepo)).rejects.toThrow();
    });
  });

  describe('readExistingHook / writeHook / removeHook', () => {
    it('readExistingHook returns undefined when no hook file exists', async () => {
      const repo = await createTemporaryRepo();
      const hookPath = await resolveHookPath(repo);

      await expect(readExistingHook(hookPath)).resolves.toBeUndefined();
    });

    it('writeHook writes the exact HOOK_SCRIPT content, executable (0755)', async () => {
      const repo = await createTemporaryRepo();
      const hookPath = await resolveHookPath(repo);

      await writeHook(hookPath);

      const content = await fs.readFile(hookPath, 'utf8');
      expect(content).toBe(HOOK_SCRIPT);
      const stats = await fs.stat(hookPath);
      expect((stats.mode & 0o777).toString(8)).toBe('755');
    });

    it('writeHook stays executable (0755) even overwriting an existing (non-executable) file', async () => {
      const repo = await createTemporaryRepo();
      const hookPath = await resolveHookPath(repo);
      await fs.ensureDir(path.dirname(hookPath));
      await fs.writeFile(hookPath, '#!/bin/sh\necho old\n', { mode: 0o644 });

      await writeHook(hookPath);

      const stats = await fs.stat(hookPath);
      expect((stats.mode & 0o777).toString(8)).toBe('755');
    });

    it('removeHook deletes the hook file', async () => {
      const repo = await createTemporaryRepo();
      const hookPath = await resolveHookPath(repo);
      await writeHook(hookPath);

      await removeHook(hookPath);

      await expect(fs.pathExists(hookPath)).resolves.toBe(false);
    });
  });
});
