import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

// Phase 4 · Task 3 — global `--json`: CLI-level (real spawned process)
// coverage proving every invocation below emits stdout that is EXACTLY one
// JSON object (nothing else on stdout — no decorative UIHelper output, no
// raw console.log line) and nothing more — "parse stdout as JSON, parse
// MUST succeed" is the actual test; the shape assertions on top of that are
// a bonus. Reuses the sandbox pattern from tests/nonInteractiveCli.test.ts
// (temp HOME, closed stdin, hard timeout).

const CLI_PATH = path.join(__dirname, '../build/index.js');

describe('global --json (CLI, spawned process)', () => {
  const temporaryDirectories: string[] = [];
  let temporaryHome: string;

  async function createTemporaryDirectory(prefix = 'dss-json-cli-'): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
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
      ...extra
    };
  }

  function runCli(
    args: string[],
    options: { cwd?: string; extraEnv?: NodeJS.ProcessEnv } = {}
  ): { stdout: string; stderr: string; status: number | null; signal: NodeJS.Signals | null } {
    const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
      cwd: options.cwd ?? temporaryHome,
      encoding: 'utf8',
      env: cliEnvironment(options.extraEnv),
      input: '',
      timeout: 10000
    });
    return { stdout: result.stdout, stderr: result.stderr, status: result.status, signal: result.signal };
  }

  /** The exactly-one-object guarantee: parse MUST succeed, and the raw
   * stdout must be nothing but that one object (trim -> parse ->
   * re-serialize equality, i.e. a single JSON value with no extra text
   * before/after/around it). */
  function parseSoleJsonObject(stdout: string): any {
    const trimmed = stdout.trim();
    const parsed = JSON.parse(trimmed);
    expect(trimmed).toBe(JSON.stringify(parsed));
    return parsed;
  }

  async function writeConfig(spaces: Array<{ name: string; email: string; userName: string; sshKeyPath?: string }>): Promise<void> {
    await fs.outputJson(path.join(temporaryHome, '.dss', 'spaces', 'config.json'), { spaces });
  }

  function runGit(cwd: string, args: string[]): string {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
  }

  beforeAll(() => {
    execFileSync('npm', ['run', 'build'], {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit'
    });
  });

  beforeEach(async () => {
    temporaryHome = await createTemporaryDirectory();
    await fs.outputFile(path.join(temporaryHome, 'empty-global.gitconfig'), '');
    await fs.ensureDir(path.join(temporaryHome, '.config'));
  });

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => fs.remove(directory)));
  });

  describe('success cases', () => {
    it('"dss ls --json": one object, ok:true, command "ls", identities[] + active', async () => {
      await writeConfig([
        { name: 'work', email: 'work@x.com', userName: 'Work', sshKeyPath: '' },
        { name: 'personal', email: 'personal@x.com', userName: 'Personal', sshKeyPath: '' }
      ]);
      // "work" is not active yet — set it via config so `active` isn't null.
      const configPath = path.join(temporaryHome, '.dss', 'spaces', 'config.json');
      const config = await fs.readJson(configPath);
      config.activeSpace = 'work';
      await fs.outputJson(configPath, config);

      const result = runCli(['ls', '--json']);

      expect(result.status).toBe(0);
      const parsed = parseSoleJsonObject(result.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.command).toBe('ls');
      expect(parsed.data.active).toBe('work');
      expect(parsed.data.identities).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'work', active: true, hasKey: false }),
          expect.objectContaining({ name: 'personal', active: false, hasKey: false })
        ])
      );
    });

    it('"dss use <name> --json": ok:true, command "use", data.switched/previous', async () => {
      await writeConfig([{ name: 'x', email: 'x@y.z', userName: 'X', sshKeyPath: '' }]);

      const result = runCli(['use', 'x', '--json']);

      expect(result.status).toBe(0);
      const parsed = parseSoleJsonObject(result.stdout);
      expect(parsed).toEqual({
        ok: true,
        command: 'use',
        data: expect.objectContaining({ switched: 'x', previous: null })
      });
    });

    it('"dss new --json" with every required flag (--key none): ok:true, command "new", data.created', async () => {
      await writeConfig([]);

      const result = runCli([
        'new', '--json',
        '--name', 'wk', '--email', 'wk@x.com', '--user', 'WK', '--host', 'github.com', '--key', 'none'
      ]);

      expect(result.status).toBe(0);
      const parsed = parseSoleJsonObject(result.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.command).toBe('new');
      expect(parsed.data.created).toEqual({ name: 'wk', email: 'wk@x.com', userName: 'WK', host: 'github.com' });
      expect(parsed.data.key).toBeNull();
    });

    it('"dss rm <name> -y --json": ok:true, command "rm", data.removed', async () => {
      await writeConfig([{ name: 'x', email: 'x@y.z', userName: 'X', sshKeyPath: '' }]);

      const result = runCli(['rm', 'x', '-y', '--json']);

      expect(result.status).toBe(0);
      const parsed = parseSoleJsonObject(result.stdout);
      expect(parsed).toEqual({ ok: true, command: 'rm', data: { removed: 'x' } });
    });

    // Keyless identity: doctor's key/ssh-config/host-auth checks all skip
    // (no network call), keeping this deterministic and fast. Doctor's own
    // exit-1 "hard failure" (a keyless identity is a hard failure) is a
    // reported HEALTH PROBLEM, not a command execution failure — the
    // checklist itself is still `ok:true` data; only process.exitCode
    // reflects the finding. See task-3-report.md for this design note.
    it('"dss doctor <name> --json" (keyless, network-free): ok:true, command "doctor", data.checks + summary; exit 1 (hard failure)', async () => {
      await writeConfig([{ name: 'personal', email: 'p@x.com', userName: 'P', sshKeyPath: '' }]);

      const result = runCli(['doctor', 'personal', '--json']);

      expect(result.status).toBe(1);
      const parsed = parseSoleJsonObject(result.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.command).toBe('doctor');
      expect(parsed.data.identity).toBe('personal');
      expect(Array.isArray(parsed.data.checks)).toBe(true);
      expect(parsed.data.checks.length).toBeGreaterThan(0);
      expect(parsed.data.summary.error).toBeGreaterThanOrEqual(1);
    });

    it('"dss status --json" inside a bound-nothing git repo: ok:true, command "status", RepositoryBindingStatus fields', async () => {
      const repository = path.join(temporaryHome, 'repository');
      await fs.ensureDir(repository);
      runGit(repository, ['init']);

      const result = runCli(['status', '--path', repository, '--json']);

      expect(result.status).toBe(0);
      const parsed = parseSoleJsonObject(result.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.command).toBe('status');
      expect(parsed.data.bound).toBe(false);
      expect(typeof parsed.data.repositoryRoot).toBe('string');
    });

    it('"dss key show <name> --json": ok:true, command "key", data.name/algorithm/fingerprint/publicKey', async () => {
      const keyPath = path.join(temporaryHome, '.dss', 'spaces', 'x', 'id_ed25519');
      await fs.ensureDir(path.dirname(keyPath));
      execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', keyPath, '-C', 'x@y.z']);
      await writeConfig([{ name: 'x', email: 'x@y.z', userName: 'X', sshKeyPath: keyPath }]);

      const result = runCli(['key', 'show', 'x', '--json']);

      expect(result.status).toBe(0);
      const parsed = parseSoleJsonObject(result.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.command).toBe('key');
      expect(parsed.data.name).toBe('x');
      expect(parsed.data.algorithm).toBe('ed25519');
      expect(typeof parsed.data.publicKey).toBe('string');
      expect(parsed.data.publicKey.length).toBeGreaterThan(0);
    });

    it('"dss config export --json": ok:true, command "config export", data.exported + path', async () => {
      await writeConfig([
        { name: 'work', email: 'work@x.com', userName: 'Work', sshKeyPath: '' },
        { name: 'personal', email: 'personal@x.com', userName: 'Personal', sshKeyPath: '' }
      ]);
      const exportPath = path.join(temporaryHome, 'export.json');

      const result = runCli(['config', 'export', exportPath, '--json']);

      expect(result.status).toBe(0);
      const parsed = parseSoleJsonObject(result.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.command).toBe('config export');
      expect(parsed.data.exported).toBe(2);
      expect(parsed.data.path).toBe(exportPath);
    });

    it('bare "dss --json" (dashboard): ok:true, command "dashboard"', async () => {
      await writeConfig([{ name: 'x', email: 'x@y.z', userName: 'X', sshKeyPath: '' }]);
      const configPath = path.join(temporaryHome, '.dss', 'spaces', 'config.json');
      const config = await fs.readJson(configPath);
      config.activeSpace = 'x';
      await fs.outputJson(configPath, config);

      const result = runCli(['--json']);

      expect(result.status).toBe(0);
      const parsed = parseSoleJsonObject(result.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.command).toBe('dashboard');
      expect(parsed.data.identity).toEqual(
        expect.objectContaining({ name: 'x', email: 'x@y.z', userName: 'X' })
      );
      expect(parsed.data.identities).toBe(1);
    });

    it('bare "dss --json" with zero identities: ok:true, {identities:0, identity:null} — firstRunFlow is skipped', async () => {
      await writeConfig([]);

      const result = runCli(['--json']);

      expect(result.status).toBe(0);
      const parsed = parseSoleJsonObject(result.stdout);
      expect(parsed).toEqual({
        ok: true,
        command: 'dashboard',
        data: { identities: 0, identity: null }
      });
    });

    it('alias case: "dss list --json" reports command "ls" (the PRIMARY name), not "list"', async () => {
      await writeConfig([{ name: 'x', email: 'x@y.z', userName: 'X', sshKeyPath: '' }]);

      const result = runCli(['list', '--json']);

      expect(result.status).toBe(0);
      // The deprecation warning still goes to stderr — JSON mode doesn't
      // touch that (stderr is free-form, per the brief).
      expect(result.stderr).toContain('"dss list" is deprecated');
      const parsed = parseSoleJsonObject(result.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.command).toBe('ls');
    });
  });

  describe('error cases', () => {
    it('"dss use does-not-exist --json": ok:false, exit 1', async () => {
      await writeConfig([{ name: 'x', email: 'x@y.z', userName: 'X', sshKeyPath: '' }]);

      const result = runCli(['use', 'does-not-exist', '--json']);

      expect(result.status).toBe(1);
      const parsed = parseSoleJsonObject(result.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.command).toBe('use');
      expect(parsed.error.message).toContain('not found');
    });

    it('"dss ls --json --nosuchflag" (Commander unknownOption): ok:false, exit 2', () => {
      const result = runCli(['ls', '--json', '--nosuchflag']);

      expect(result.status).toBe(2);
      const parsed = parseSoleJsonObject(result.stdout);
      expect(parsed.ok).toBe(false);
      expect(typeof parsed.error.message).toBe('string');
    });

    it('"dss new --json" with no flags at all (missing non-interactive input): ok:false, exit 2', async () => {
      await writeConfig([]);

      const result = runCli(['new', '--json']);

      expect(result.status).toBe(2);
      const parsed = parseSoleJsonObject(result.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.command).toBe('new');
      expect(parsed.error.message).toContain('Missing required value: pass --name (non-interactive mode)');
    });

    it('"dss nosuchcommand --json" (Commander unknownCommand, no command ever resolves): ok:false, exit 2, command falls back to "dss"', () => {
      const result = runCli(['--json', 'nosuchcommand']);

      expect(result.status).toBe(2);
      const parsed = parseSoleJsonObject(result.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.command).toBe('dss');
    });
  });

  describe('PLAIN-mode interplay', () => {
    it('--json wins trivially over PLAIN decorations: identical single-object output whether or not NO_COLOR is set', async () => {
      await writeConfig([{ name: 'x', email: 'x@y.z', userName: 'X', sshKeyPath: '' }]);

      const withoutNoColor = runCli(['ls', '--json']);
      const withNoColor = runCli(['ls', '--json'], { extraEnv: { NO_COLOR: '1' } });

      expect(parseSoleJsonObject(withoutNoColor.stdout)).toEqual(parseSoleJsonObject(withNoColor.stdout));
    });
  });
});
