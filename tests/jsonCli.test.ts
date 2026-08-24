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
    // See tests/nonInteractiveCli.test.ts's beforeAll for why this is
    // skippable (review finding #5) — CI sets DSS_SKIP_TEST_BUILD=1 since
    // it already builds as its own step; local `npm test` still builds.
    if (process.env.DSS_SKIP_TEST_BUILD === '1') return;
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

    // Review finding #3: `use`'s payload must be EXACTLY {switched,
    // previous} — no foreign keys leaked in from the trailing decorative
    // listSpaces() recap (skipped entirely in JSON mode).
    it('"dss use <name> --json": ok:true, command "use", data is EXACTLY {switched, previous}', async () => {
      await writeConfig([{ name: 'x', email: 'x@y.z', userName: 'X', sshKeyPath: '' }]);

      const result = runCli(['use', 'x', '--json']);

      expect(result.status).toBe(0);
      const parsed = parseSoleJsonObject(result.stdout);
      expect(parsed).toEqual({
        ok: true,
        command: 'use',
        data: { switched: 'x', previous: null }
      });
      expect(Object.keys(parsed.data).sort()).toEqual(['previous', 'switched']);
    });

    // Review finding #3: `new`'s payload must be EXACTLY {created, key,
    // switched} even though it internally calls switchSpace() when the
    // "switch now?" confirm resolves true (default in -y/non-interactive
    // mode) — jsonSetData() (replace, not merge) at the end of addSpace()
    // guarantees this regardless of what that inner call merged in.
    it('"dss new --json" with every required flag (--key none, -y so it also switches): ok:true, command "new", data is EXACTLY {created, key, switched}', async () => {
      await writeConfig([]);

      const result = runCli([
        'new', '--json', '-y',
        '--name', 'wk', '--email', 'wk@x.com', '--user', 'WK', '--host', 'github.com', '--key', 'none'
      ]);

      expect(result.status).toBe(0);
      const parsed = parseSoleJsonObject(result.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.command).toBe('new');
      expect(parsed.data).toEqual({
        created: { name: 'wk', email: 'wk@x.com', userName: 'WK', host: 'github.com' },
        key: null,
        switched: true
      });
      expect(Object.keys(parsed.data).sort()).toEqual(['created', 'key', 'switched']);
    });

    it('"dss rm <name> -y --json": ok:true, command "rm", data.removed', async () => {
      await writeConfig([{ name: 'x', email: 'x@y.z', userName: 'X', sshKeyPath: '' }]);

      const result = runCli(['rm', 'x', '-y', '--json']);

      expect(result.status).toBe(0);
      const parsed = parseSoleJsonObject(result.stdout);
      expect(parsed).toEqual({ ok: true, command: 'rm', data: { removed: 'x' } });
    });

    // Keyless identity: doctor's key/ssh-config/host-auth checks all skip
    // (no network call), keeping this deterministic and fast. Review
    // finding #2 (ruled fix): a JSON failure payload keeps `data` ALONGSIDE
    // `error` whenever the command produced one — doctor's own exit-1 "hard
    // failure" (a keyless identity) still carries its full checks[]/summary
    // (exactly what AGENTS.md documents for this recipe), plus a real error
    // message (not the generic "command failed" fallback) naming how many
    // checks failed.
    it('"dss doctor <name> --json" (keyless, network-free, hard failure): ok:false, exit 1, real error message, data present with checks/summary', async () => {
      await writeConfig([{ name: 'personal', email: 'p@x.com', userName: 'P', sshKeyPath: '' }]);

      const result = runCli(['doctor', 'personal', '--json']);

      expect(result.status).toBe(1);
      const parsed = parseSoleJsonObject(result.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.command).toBe('doctor');
      expect(parsed.error.message).toBe('1 check(s) failed');
      expect(parsed.data.identity).toBe('personal');
      expect(Array.isArray(parsed.data.checks)).toBe(true);
      expect(parsed.data.checks.length).toBeGreaterThan(0);
      expect(parsed.data.summary).toEqual({ ok: expect.any(Number), warn: expect.any(Number), error: 1 });
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

    it('bare "dss --json" with zero identities: ok:true, all 4 stable keys present (identity/source/health null) — firstRunFlow is skipped', async () => {
      await writeConfig([]);

      const result = runCli(['--json']);

      expect(result.status).toBe(0);
      const parsed = parseSoleJsonObject(result.stdout);
      expect(parsed).toEqual({
        ok: true,
        command: 'dashboard',
        data: { identity: null, source: null, health: null, identities: 0 }
      });
    });

    it('bare "dss --json" with identities but none resolved here (no active, not bound): all 4 stable keys present (identity/source/health null)', async () => {
      await writeConfig([{ name: 'x', email: 'x@y.z', userName: 'X', sshKeyPath: '' }]);
      // temporaryHome (the default cwd) is not a git repository and the
      // config above never sets activeSpace — nothing for the dashboard to
      // resolve, distinct from the zero-identities branch above (this one
      // reports identities:1, not 0).

      const result = runCli(['--json']);

      expect(result.status).toBe(0);
      const parsed = parseSoleJsonObject(result.stdout);
      expect(parsed).toEqual({
        ok: true,
        command: 'dashboard',
        data: { identity: null, source: null, health: null, identities: 1 }
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

    // Review finding #3: a fresh (empty) store must not detour "use <name>"
    // into firstRunFlow and exit 0 — a name was supplied, so it's looked up
    // and fails "not found" (exit 1) exactly like the non-empty-store case
    // above, regardless of store size.
    it('"dss use nope --json" on a FRESH (empty) store: ok:false, exit 1, "not found"', async () => {
      await writeConfig([]);

      const result = runCli(['use', 'nope', '--json']);

      expect(result.status).toBe(1);
      const parsed = parseSoleJsonObject(result.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.command).toBe('use');
      expect(parsed.error.message).toContain('not found');
    });

    // Review finding #1: 'commander.help' dual-purpose case, in JSON mode —
    // a wrong invocation (no subcommand) must be a real error object, not an
    // empty/placeholder data.help and not exit 0.
    it('"dss config --json" with no subcommand: ok:false, exit 2, single parseable object with a real error message', () => {
      const result = runCli(['config', '--json']);

      expect(result.status).toBe(2);
      const parsed = parseSoleJsonObject(result.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.command).toBe('dss');
      expect(typeof parsed.error.message).toBe('string');
      expect(parsed.error.message.length).toBeGreaterThan(0);
      expect(parsed.error.message).not.toBe('(outputHelp)');
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

    // Review finding #4: an unsupported shell value must exit 2 (UsageError)
    // in JSON mode too, as a single ok:false object — not exit 0 with a
    // bare stderr/stdout error line.
    it('"dss completion tcsh --json" (unsupported shell): ok:false, exit 2, single parseable object', () => {
      const result = runCli(['completion', 'tcsh', '--json']);

      expect(result.status).toBe(2);
      const parsed = parseSoleJsonObject(result.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.command).toBe('completion');
      expect(parsed.error.message).toContain('not supported');
    });

    it('"dss nosuchcommand --json" (Commander unknownCommand, no command ever resolves): ok:false, exit 2, command falls back to "dss"', () => {
      const result = runCli(['--json', 'nosuchcommand']);

      expect(result.status).toBe(2);
      const parsed = parseSoleJsonObject(result.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.command).toBe('dss');
    });

    // Review finding #1: `link --recursive`'s partial-failure summary sets
    // process.exitCode = 1 directly (never calls fail()/jsonFail()) — `ok`
    // must still mirror that non-zero exit code. One repo's `.git`
    // directory is made read-only so binding it fails while a sibling repo
    // succeeds, reproducing the exact "N succeeded, M failed" partial case.
    // Review finding #2: this is exactly the "partial failure" data
    // AGENTS.md documents (`bound`/`failed`) — it must survive onto the
    // failure payload's `data` key alongside the generic error message
    // (binding.ts never calls fail()/jsonFail() for this path either).
    // Skipped when running as root: chmod-based write denial has no effect
    // for root, so the induced failure (and thus the whole point of this
    // test — a genuine partial failure) wouldn't reproduce.
    const itUnlessRoot = (process.getuid?.() ?? 1) === 0 ? it.skip : it;
    itUnlessRoot('"dss link --recursive --json" with a partial failure (one repo binds, one fails): ok:false, exit 1, generic error message, data present with bound/failed', async () => {
      const parentDirectory = path.join(temporaryHome, 'parent');
      const repositoryA = path.join(parentDirectory, 'repoA');
      const repositoryB = path.join(parentDirectory, 'repoB');
      await fs.ensureDir(repositoryA);
      await fs.ensureDir(repositoryB);
      runGit(repositoryA, ['init']);
      runGit(repositoryB, ['init']);
      // repoB's .git directory becomes unwritable — binding it fails with
      // EACCES while repoA (untouched) succeeds normally.
      await fs.chmod(path.join(repositoryB, '.git'), 0o555);

      const keyPath = path.join(temporaryHome, 'fake-key');
      await fs.outputFile(keyPath, 'not a real key, only its path is checked');
      await writeConfig([{ name: 'work', email: 'work@x.com', userName: 'Work', sshKeyPath: keyPath }]);

      try {
        const result = runCli(['link', 'work', '-y', '--recursive', parentDirectory, '--json']);

        expect(result.status).toBe(1);
        const parsed = parseSoleJsonObject(result.stdout);
        expect(parsed.ok).toBe(false);
        expect(parsed.command).toBe('link');
        expect(parsed.error).toEqual({ message: 'command failed' });
        expect(parsed.data.bound).toEqual([{ path: repositoryA, identity: 'work' }]);
        expect(parsed.data.failed).toHaveLength(1);
        expect(parsed.data.failed[0].repositoryPath).toBe(repositoryB);
      } finally {
        // Restore permissions so the temp-directory cleanup in afterEach
        // can actually remove repoB's .git directory.
        await fs.chmod(path.join(repositoryB, '.git'), 0o755);
      }
    });
  });

  // Review finding #2: --help/--version + --json must emit ONLY the JSON
  // object — no leaked help/version text before it — REGARDLESS of argv
  // order (Commander's -v/-h handlers throw/exit as soon as they're
  // encountered mid-parse, so `--json` appearing AFTER `-v`/`-h` in argv is
  // the specific case that used to break: the option:json event never got
  // a chance to fire before -v's handler ran).
  describe('--help / --version + --json (order-independent)', () => {
    it('"dss --help --json": ok:true, command "dss", data.help is Commander\'s full help text, nothing else on stdout', () => {
      const result = runCli(['--help', '--json']);

      expect(result.status).toBe(0);
      const parsed = parseSoleJsonObject(result.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.command).toBe('dss');
      expect(typeof parsed.data.help).toBe('string');
      expect(parsed.data.help).toContain('Usage: dss');
      expect(parsed.data.help).toContain('Commands:');
      expect(Object.keys(parsed.data)).toEqual(['help']);
    });

    it('"dss --json --help" (--json BEFORE --help): identical single-object output', () => {
      const result = runCli(['--json', '--help']);

      expect(result.status).toBe(0);
      const parsed = parseSoleJsonObject(result.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.command).toBe('dss');
      expect(parsed.data.help).toContain('Usage: dss');
    });

    it('"dss -v --json" (-v BEFORE --json — the exact reported regression): ok:true, data.version, exit 0', () => {
      const result = runCli(['-v', '--json']);

      expect(result.status).toBe(0);
      const parsed = parseSoleJsonObject(result.stdout);
      expect(parsed).toEqual({
        ok: true,
        command: 'dss',
        data: { version: expect.any(String) }
      });
      expect(parsed.data.version.length).toBeGreaterThan(0);
    });

    it('"dss --json -v" (--json BEFORE -v): identical single-object output', () => {
      const result = runCli(['--json', '-v']);

      expect(result.status).toBe(0);
      const parsed = parseSoleJsonObject(result.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.command).toBe('dss');
      expect(typeof parsed.data.version).toBe('string');
    });

    it('"dss --version --json" (long flag form, both orders) also works', () => {
      const first = runCli(['--version', '--json']);
      const second = runCli(['--json', '--version']);

      for (const result of [first, second]) {
        expect(result.status).toBe(0);
        const parsed = parseSoleJsonObject(result.stdout);
        expect(parsed.ok).toBe(true);
        expect(typeof parsed.data.version).toBe('string');
      }
    });

    it('without --json, --help/-v still print their normal text (unchanged non-JSON behavior)', () => {
      const help = runCli(['--help']);
      const version = runCli(['-v']);

      expect(help.status).toBe(0);
      expect(help.stdout).toContain('Usage: dss');
      // Not JSON — a plain-text help dump doesn't parse as one object.
      expect(() => JSON.parse(help.stdout.trim())).toThrow();

      expect(version.status).toBe(0);
      expect(version.stdout.trim().length).toBeGreaterThan(0);
      expect(() => JSON.parse(version.stdout.trim())).toThrow();
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
