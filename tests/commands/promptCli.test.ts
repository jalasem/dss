import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

// `dss prompt` (Phase 5 · Task 4): CLI-level (real spawned process)
// coverage. Complements the mocked unit coverage in
// tests/commands/prompt.test.ts with the things that only mean something
// against the real thing: real bound/rule/global fixtures resolving
// through the real `resolveAppliesHere`, PLAIN output over a real pipe
// (spawnSync's stdout is never a TTY, matching real `| cat`/prompt-capture
// usage), and — the mandatory proof for the never-break contract — a
// genuinely corrupted store file and a genuinely git-failing cwd, both
// still producing exit 0 with empty output and no stack trace on stderr.

const CLI_PATH = path.join(__dirname, '../../build/index.js');

describe('dss prompt CLI', () => {
  const temporaryDirectories: string[] = [];
  let temporaryHome: string;

  async function createTemporaryDirectory(): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-prompt-cli-'));
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
    cwd: string = temporaryHome,
    extraEnv: NodeJS.ProcessEnv = {}
  ): { stdout: string; stderr: string; status: number | null } {
    const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
      cwd,
      encoding: 'utf8',
      env: cliEnvironment(extraEnv),
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
    switchToIt: boolean,
    keyType: 'none' | 'ed25519' = 'none'
  ): Promise<void> {
    const args = [
      'new', '--json',
      '--name', name, '--email', email, '--user', userName,
      '--host', 'github.com', '--key', keyType
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

  beforeAll(() => {
    // See tests/nonInteractiveCli.test.ts's beforeAll for why this is
    // skippable — CI sets DSS_SKIP_TEST_BUILD=1 since it already builds as
    // its own step; local `npm test` still builds.
    if (process.env.DSS_SKIP_TEST_BUILD === '1') return;
    execFileSync('npm', ['run', 'build'], {
      cwd: path.join(__dirname, '../..'),
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

  describe('sources', () => {
    it('empty store: exit 0, empty stdout, no stderr', async () => {
      const result = runCli(['prompt']);

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    });

    it('global default (dss use): PLAIN "name", --json { identity, source: "global" }', async () => {
      await createIdentity('work', 'work@example.com', 'Work User', true);

      const plain = runCli(['prompt']);
      expect(plain.status).toBe(0);
      expect(plain.stdout).toBe('work\n');

      const json = runCli(['prompt', '--json']);
      expect(json.status).toBe(0);
      const parsed = parseSoleJsonObject(json.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.data).toEqual({ identity: 'work', source: 'global' });
    });

    it('directory rule (dss rule add): --json source "rule"', async () => {
      await createIdentity('personal', 'personal@example.com', 'Personal User', false);
      const ruleDir = await createTemporaryDirectory();
      const add = runCli(['rule', 'add', ruleDir, 'personal', '--json']);
      expect(add.status).toBe(0);

      const result = runCli(['prompt', '--json'], ruleDir);

      expect(result.status).toBe(0);
      const parsed = parseSoleJsonObject(result.stdout);
      expect(parsed.data).toEqual({ identity: 'personal', source: 'rule' });
    });

    it('repo binding (dss link): --json source "bound", overriding the global default', async () => {
      await createIdentity('work', 'work@example.com', 'Work User', true);
      // dss link refuses an identity with no SSH key at all, so this one
      // (unlike this suite's other fixtures) needs a REAL generated key.
      await createIdentity('side', 'side@example.com', 'Side User', false, 'ed25519');
      const repoDir = await initRepo('repo');
      const link = runCli(['link', 'side', '--json'], repoDir);
      expect(link.status).toBe(0);

      const result = runCli(['prompt', '--json'], repoDir);

      expect(result.status).toBe(0);
      const parsed = parseSoleJsonObject(result.stdout);
      expect(parsed.data).toEqual({ identity: 'side', source: 'bound' });
    });

    it('--source appends the plain "(repo)"/"(rule)"/"(global)" hint over a pipe', async () => {
      await createIdentity('work', 'work@example.com', 'Work User', true);

      const result = runCli(['prompt', '--source']);

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('work (global)\n');
    });

    it('no identity applies here (identities exist, but none bound/ruled/active): empty output', async () => {
      await createIdentity('work', 'work@example.com', 'Work User', false); // never switched to

      const result = runCli(['prompt']);

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
    });
  });

  // ---------------------------------------------------------------------
  // MANDATORY never-break proof: a genuinely corrupted store, and a
  // genuinely git-failing cwd, both still exit 0 with empty (or
  // best-effort) output and no stack trace on stderr.
  // ---------------------------------------------------------------------
  describe('the never-break contract', () => {
    it('a store this build cannot understand (version newer than 2) still exits 0 with empty output, no stderr noise', async () => {
      // infra/store.ts's loadStore() HARD-ERRORS (throws) on a numeric
      // version newer than it understands, precisely so a genuinely
      // incompatible store is never silently reduced to an empty one —
      // see tests/infra/store.test.ts's "version gating" suite. That
      // throw is exactly the kind of failure `dss prompt`'s never-break
      // wrapper exists to swallow.
      await fs.outputJson(path.join(temporaryHome, '.dss', 'spaces', 'config.json'), {
        version: 3,
        identities: [{ name: 'x', email: 'x@y.z', userName: 'X' }]
      });

      const result = runCli(['prompt']);

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    });

    it('the same corrupted store in --json mode: exit 0, single best-effort {identity:null, source:null} object', async () => {
      await fs.outputJson(path.join(temporaryHome, '.dss', 'spaces', 'config.json'), {
        version: 3,
        identities: []
      });

      const result = runCli(['prompt', '--json']);

      expect(result.status).toBe(0);
      const parsed = parseSoleJsonObject(result.stdout);
      expect(parsed).toEqual({ ok: true, command: 'prompt', data: { identity: null, source: null } });
    });

    it('unparseable JSON store: loadStore itself recovers (documented elsewhere), and dss prompt still exits 0 empty on top of that', async () => {
      await fs.ensureDir(path.join(temporaryHome, '.dss', 'spaces'));
      await fs.writeFile(path.join(temporaryHome, '.dss', 'spaces', 'config.json'), '{ not valid json');

      const result = runCli(['prompt']);

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    });

    it('a cwd whose .git is malformed (git itself fails resolving it) still exits 0 with empty output, no stderr noise', async () => {
      await createIdentity('work', 'work@example.com', 'Work User', true);
      const brokenRepoDir = path.join(temporaryHome, 'broken-repo');
      await fs.ensureDir(brokenRepoDir);
      // A ".git" FILE (not the special "gitdir: <path>" pointer format
      // worktrees use) with garbage content — `git rev-parse` fails here
      // with a real git error ("not a git repository: <content>..."),
      // exercising an actual git FAILURE rather than merely "not a repo
      // at all". resolveAppliesHere already degrades this gracefully
      // (falls through to the global default) — this proves the whole
      // pipeline, including dss prompt's own wrapper, survives it too.
      await fs.writeFile(path.join(brokenRepoDir, '.git'), 'this is not a valid gitdir pointer\n');

      const result = runCli(['prompt'], brokenRepoDir);

      // Falls through past the broken binding lookup to the global
      // default ("work") rather than crashing — proves the never-break
      // wrapper doesn't have to mean "always empty", just "never throws
      // or exits non-zero".
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('work\n');
      expect(result.stderr).toBe('');
    });

    it('a cwd with no git binary reachable on PATH at all still exits 0 with empty (or best-effort) output, no stderr noise', async () => {
      await createIdentity('work', 'work@example.com', 'Work User', true);
      const repoDir = await initRepo('repo');

      // An empty directory as the ENTIRE PATH: `git` genuinely cannot be
      // found (unlike '/usr/bin:/bin', which still has a real `git` on
      // macOS). process.execPath is absolute, so node itself still runs.
      const emptyPathDir = await createTemporaryDirectory();
      const bareEnv = { PATH: emptyPathDir };
      const result = runCli(['prompt'], repoDir, bareEnv);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      // Whatever it resolves to (global fallback, since binding lookup
      // fails and there's no rule) — the point is it neither throws nor
      // exits non-zero.
      expect(result.stdout).toBe('work\n');
    });
  });

  describe('--source and --json together are unaffected by each other', () => {
    it('--json ignores --source (payload shape is always {identity, source}, no extra key)', async () => {
      await createIdentity('work', 'work@example.com', 'Work User', true);

      const result = runCli(['prompt', '--source', '--json']);

      expect(result.status).toBe(0);
      const parsed = parseSoleJsonObject(result.stdout);
      expect(Object.keys(parsed.data).sort()).toEqual(['identity', 'source']);
    });
  });
});
