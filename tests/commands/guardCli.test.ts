import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

// `dss guard install|uninstall|check` (Phase 5 · Task 3): the opt-in
// pre-commit hook half of the wrong-identity guard. CLI-level (real spawned
// process) coverage, including the mandatory load-bearing proof: a REAL
// `git commit`, run through the ACTUAL installed hook, blocked on a
// mismatched identity and allowed on a matching one — with `dss` reached
// the same way it would be on a real machine, via PATH, not a direct
// `node build/index.js` invocation.

const CLI_PATH = path.join(__dirname, '../../build/index.js');

describe('dss guard install|uninstall|check CLI', () => {
  const temporaryDirectories: string[] = [];
  let temporaryHome: string;
  let shimDir: string;

  async function createTemporaryDirectory(): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-guard-cli-'));
    temporaryDirectories.push(directory);
    return fs.realpath(directory);
  }

  function cliEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
      ...process.env,
      HOME: temporaryHome,
      GIT_CONFIG_GLOBAL: path.join(temporaryHome, 'empty-global.gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      XDG_CONFIG_HOME: path.join(temporaryHome, '.config'),
      // PATH-prefixed with the shim dir (below) so a hook script's bare
      // `dss` invocation — exactly how a real installed hook reaches it —
      // resolves to this sandbox's own build, not anything else on PATH.
      PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ''}`,
      ...extra
    };
  }

  function runCli(args: string[], cwd: string = temporaryHome): { stdout: string; stderr: string; status: number | null } {
    const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
      cwd,
      encoding: 'utf8',
      env: cliEnvironment(),
      input: '',
      timeout: 10000
    });
    return { stdout: result.stdout, stderr: result.stderr, status: result.status };
  }

  function runGit(cwd: string, args: string[]): string {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      env: cliEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
  }

  // A PATH containing only git's own directory plus the bare system
  // dirs — deliberately excludes the shim dir (and any global npm bin
  // directory that might otherwise have `dss` installed on this machine)
  // so "dss unreachable" is actually guaranteed, not just "hopefully not
  // found via the ambient PATH".
  function pathWithoutDss(): string {
    const gitPath = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    return [path.dirname(gitPath), '/usr/bin', '/bin'].join(path.delimiter);
  }

  function commitCount(cwd: string): number {
    try {
      return parseInt(runGit(cwd, ['rev-list', '--count', 'HEAD']), 10);
    } catch {
      return 0;
    }
  }

  function parseSoleJsonObject(stdout: string): any {
    const trimmed = stdout.trim();
    const parsed = JSON.parse(trimmed);
    expect(trimmed).toBe(JSON.stringify(parsed));
    return parsed;
  }

  async function createIdentity(
    name: string,
    email: string,
    userName: string,
    switchToIt: boolean
  ): Promise<void> {
    const args = [
      'new', '--json',
      '--name', name, '--email', email, '--user', userName,
      '--host', 'github.com', '--key', 'none'
    ];
    if (switchToIt) args.push('-y');
    const result = runCli(args);
    expect(result.status).toBe(0);
  }

  async function initRepo(name: string): Promise<string> {
    const repoDir = path.join(temporaryHome, name);
    await fs.ensureDir(repoDir);
    runGit(repoDir, ['init']);
    return repoDir;
  }

  beforeAll(async () => {
    // See tests/nonInteractiveCli.test.ts's beforeAll for why this is
    // skippable (CI sets DSS_SKIP_TEST_BUILD=1 since it already builds as
    // its own step; local `npm test` still builds).
    if (process.env.DSS_SKIP_TEST_BUILD !== '1') {
      execFileSync('npm', ['run', 'build'], {
        cwd: path.join(__dirname, '../..'),
        stdio: 'inherit'
      });
    }

    // A `dss` shim on PATH: the ONLY way a shell hook script's bare `dss`
    // invocation can resolve — mirrors how `dss guard install` is actually
    // used on a real machine (a global npm install puts `dss` on PATH),
    // rather than the direct `node build/index.js` every other CLI suite
    // uses for its own top-level invocations.
    shimDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-guard-shim-'));
    const shimPath = path.join(shimDir, 'dss');
    await fs.writeFile(shimPath, `#!/bin/sh\nexec "${process.execPath}" "${CLI_PATH}" "$@"\n`);
    await fs.chmod(shimPath, 0o755);
  });

  afterAll(async () => {
    if (shimDir) await fs.remove(shimDir);
  });

  beforeEach(async () => {
    temporaryHome = await createTemporaryDirectory();
    await fs.outputFile(path.join(temporaryHome, 'empty-global.gitconfig'), '');
    await fs.ensureDir(path.join(temporaryHome, '.config'));
  });

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => fs.remove(directory)));
  });

  describe('dss guard install', () => {
    it('writes a marked, executable hook at the git-resolved hooks path, and reports { installed } in --json', async () => {
      const repoDir = await initRepo('repo');

      const result = runCli(['guard', 'install', '--json'], repoDir);

      expect(result.status).toBe(0);
      const parsed = parseSoleJsonObject(result.stdout);
      expect(parsed.ok).toBe(true);
      const expectedHookPath = path.join(repoDir, '.git', 'hooks', 'pre-commit');
      expect(parsed.data.installed).toBe(expectedHookPath);

      const content = await fs.readFile(expectedHookPath, 'utf8');
      expect(content).toContain('# dss-guard v1');
      expect(content).toContain('dss guard check --quiet || exit 1');
      const stats = await fs.stat(expectedHookPath);
      expect((stats.mode & 0o777).toString(8)).toBe('755');
    });

    it('fails (exit 1) when cwd is not a Git repository', () => {
      const result = runCli(['guard', 'install', '--json'], temporaryHome);

      expect(result.status).toBe(1);
      const parsed = parseSoleJsonObject(result.stdout);
      expect(parsed.ok).toBe(false);
    });

    it('is idempotent: reinstalling over a dss-marked hook rewrites it silently', async () => {
      const repoDir = await initRepo('repo');

      const first = runCli(['guard', 'install', '--json'], repoDir);
      expect(first.status).toBe(0);
      const second = runCli(['guard', 'install', '--json'], repoDir);
      expect(second.status).toBe(0);

      const hookPath = path.join(repoDir, '.git', 'hooks', 'pre-commit');
      const content = await fs.readFile(hookPath, 'utf8');
      expect(content).toContain('# dss-guard v1');
    });

    it('refuses (exit 1) to overwrite a pre-commit hook it did not write, and prints manual-integration instructions', async () => {
      const repoDir = await initRepo('repo-foreign');
      const hookPath = path.join(repoDir, '.git', 'hooks', 'pre-commit');
      await fs.ensureDir(path.dirname(hookPath));
      await fs.writeFile(hookPath, '#!/bin/sh\necho "not dss"\n', { mode: 0o755 });

      const result = runCli(['guard', 'install', '--json'], repoDir);

      expect(result.status).toBe(1);
      const parsed = parseSoleJsonObject(result.stdout);
      expect(parsed.error.message).toContain('not written by DSS');
      expect(parsed.error.message).toContain('dss guard check --quiet || exit 1');

      const content = await fs.readFile(hookPath, 'utf8');
      expect(content).toContain('not dss'); // untouched
    });
  });

  describe('dss guard uninstall', () => {
    it('removes a dss-marked hook and reports { removed: <path> }', async () => {
      const repoDir = await initRepo('repo');
      runCli(['guard', 'install'], repoDir);
      const hookPath = path.join(repoDir, '.git', 'hooks', 'pre-commit');
      expect(await fs.pathExists(hookPath)).toBe(true);

      const result = runCli(['guard', 'uninstall', '--json'], repoDir);

      expect(result.status).toBe(0);
      const parsed = parseSoleJsonObject(result.stdout);
      expect(parsed.data).toEqual({ removed: hookPath });
      expect(await fs.pathExists(hookPath)).toBe(false);
    });

    it('reports { removed: null } (exit 0) when no hook is installed', async () => {
      const repoDir = await initRepo('repo');

      const result = runCli(['guard', 'uninstall', '--json'], repoDir);

      expect(result.status).toBe(0);
      const parsed = parseSoleJsonObject(result.stdout);
      expect(parsed.data).toEqual({ removed: null });
    });

    it('refuses (exit 1) to remove a foreign pre-commit hook', async () => {
      const repoDir = await initRepo('repo-foreign');
      const hookPath = path.join(repoDir, '.git', 'hooks', 'pre-commit');
      await fs.ensureDir(path.dirname(hookPath));
      await fs.writeFile(hookPath, '#!/bin/sh\necho "not dss"\n', { mode: 0o755 });

      const result = runCli(['guard', 'uninstall', '--json'], repoDir);

      expect(result.status).toBe(1);
      const parsed = parseSoleJsonObject(result.stdout);
      expect(parsed.error.message).toContain('not written by DSS');
      const content = await fs.readFile(hookPath, 'utf8');
      expect(content).toContain('not dss'); // untouched
    });
  });

  describe('dss guard check', () => {
    it('no identity applies here (fresh store, no rule/bound/active) → exit 0 silently with { ok:true, expected:null, effective:null }', async () => {
      const result = runCli(['guard', 'check', '--json'], temporaryHome);

      expect(result.status).toBe(0);
      const parsed = parseSoleJsonObject(result.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.data).toEqual({ ok: true, expected: null, effective: null });
    });

    it('match: exit 0, { ok:true, expected:{identity,email,source}, effective }; --quiet suppresses the success line', async () => {
      await createIdentity('work', 'work@example.com', 'Work User', true);
      const repoDir = await initRepo('repo');

      const quiet = runCli(['guard', 'check', '--quiet'], repoDir);
      expect(quiet.status).toBe(0);
      expect(quiet.stdout.trim()).toBe('');

      const result = runCli(['guard', 'check', '--json'], repoDir);
      expect(result.status).toBe(0);
      const parsed = parseSoleJsonObject(result.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.data).toEqual({
        ok: true,
        expected: { identity: 'work', email: 'work@example.com', source: 'global' },
        effective: 'work@example.com'
      });
    });

    it('mismatch: exit 1, { ok:false, expected, effective }, and an actionable message with fix hints — always prints even without --quiet', async () => {
      await createIdentity('work', 'work@example.com', 'Work User', true);
      const repoDir = await initRepo('repo');
      runGit(repoDir, ['config', 'user.email', 'wrong@example.com']);

      const result = runCli(['guard', 'check', '--json'], repoDir);

      expect(result.status).toBe(1);
      const parsed = parseSoleJsonObject(result.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error.message).toContain('expected work@example.com');
      expect(parsed.error.message).toContain('wrong@example.com');
      expect(parsed.error.message).toContain('dss use work');
      expect(parsed.error.message).toContain('dss link work');
      expect(parsed.data).toEqual({
        ok: false,
        expected: { identity: 'work', email: 'work@example.com', source: 'global' },
        effective: 'wrong@example.com'
      });

      const plain = runCli(['guard', 'check'], repoDir); // no --json, no --quiet
      expect(plain.status).toBe(1);
      expect(plain.stdout).toMatch(/Wrong identity/);
    });
  });

  // ---------------------------------------------------------------------
  // MANDATORY end-to-end proof: a REAL `git commit`, run through the ACTUAL
  // installed hook (not `dss guard check` invoked directly), blocked when
  // the effective identity mismatches and allowed when it matches — `dss`
  // resolved via PATH exactly as an installed hook would resolve it.
  // ---------------------------------------------------------------------
  describe('end-to-end: a real `git commit` goes through the installed hook', () => {
    it('blocks the commit (no commit object created) when the repo-local identity mismatches what DSS expects', async () => {
      await createIdentity('work', 'work@example.com', 'Work User', true);
      const repoDir = await initRepo('blocked-repo');
      runGit(repoDir, ['config', 'user.email', 'wrong@example.com']);
      runGit(repoDir, ['config', 'user.name', 'Wrong Person']);

      const install = runCli(['guard', 'install'], repoDir);
      expect(install.status).toBe(0);

      await fs.outputFile(path.join(repoDir, 'file.txt'), 'v1');
      runGit(repoDir, ['add', 'file.txt']);

      const commit = spawnSync('git', ['-C', repoDir, 'commit', '-m', 'should be blocked'], {
        encoding: 'utf8',
        env: cliEnvironment()
      });

      expect(commit.status).not.toBe(0);
      expect(`${commit.stdout}${commit.stderr}`).toMatch(/Wrong identity/);
      expect(commitCount(repoDir)).toBe(0);
    });

    it('allows the commit when the effective identity (resolved through the DSS include chain) matches', async () => {
      await createIdentity('work', 'work@example.com', 'Work User', true);
      const repoDir = await initRepo('allowed-repo');

      const install = runCli(['guard', 'install'], repoDir);
      expect(install.status).toBe(0);

      await fs.outputFile(path.join(repoDir, 'file.txt'), 'v1');
      runGit(repoDir, ['add', 'file.txt']);

      const commit = spawnSync('git', ['-C', repoDir, 'commit', '-m', 'should be allowed'], {
        encoding: 'utf8',
        env: cliEnvironment()
      });

      expect(commit.status).toBe(0);
      expect(commitCount(repoDir)).toBe(1);
    });

    it('a hook installed but "dss" missing from PATH never bricks the commit (the missing-dss guard line)', async () => {
      await createIdentity('work', 'work@example.com', 'Work User', true);
      const repoDir = await initRepo('no-dss-on-path-repo');
      runGit(repoDir, ['config', 'user.email', 'wrong@example.com']); // would otherwise be blocked

      const install = runCli(['guard', 'install'], repoDir);
      expect(install.status).toBe(0);

      await fs.outputFile(path.join(repoDir, 'file.txt'), 'v1');
      runGit(repoDir, ['add', 'file.txt']);

      // Same env, but WITHOUT the shim dir (or any other dss) on PATH.
      const bareEnv = { ...cliEnvironment(), PATH: pathWithoutDss() };
      const commit = spawnSync('git', ['-C', repoDir, 'commit', '-m', 'allowed despite mismatch, dss unreachable'], {
        encoding: 'utf8',
        env: bareEnv
      });

      expect(commit.status).toBe(0);
      expect(commitCount(repoDir)).toBe(1);
    });
  });
});
