import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

// `dss clone` (Phase 5 · Task 2): rule/host-aware identity selection + a
// keyed/plain `git clone` + auto-bind. CLI-level (real spawned process,
// real git) coverage — deliberately network-free: every fixture here is a
// LOCAL bare repository (`git init --bare`), matched by parseGitUrl's
// local-path form (host undefined, host-match step skipped — see
// src/core/gitUrl.ts). The host-match ("reason: host"/"several identities
// prompt") branches are covered at the unit level instead
// (tests/commands/clone.test.ts), since exercising them for real would need
// an actual remote host.

const CLI_PATH = path.join(__dirname, '../../build/index.js');

describe('dss clone CLI (local bare-repo fixture, no network)', () => {
  const temporaryDirectories: string[] = [];
  let temporaryHome: string;
  let bareRepo: string;

  async function createTemporaryDirectory(): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-clone-cli-'));
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

  function runCli(args: string[], cwd: string = temporaryHome): { stdout: string; stderr: string; status: number | null } {
    const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
      cwd,
      encoding: 'utf8',
      env: cliEnvironment(),
      input: '',
      timeout: 15000
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

  async function createIdentity(name: string, email: string, userName: string): Promise<void> {
    const result = runCli([
      'new', '--json', '-y',
      '--name', name, '--email', email, '--user', userName,
      '--host', 'github.com', '--key', 'none'
    ]);
    expect(result.status).toBe(0);
  }

  beforeAll(() => {
    // See tests/nonInteractiveCli.test.ts's beforeAll for why this is
    // skippable (CI sets DSS_SKIP_TEST_BUILD=1 since it already builds as
    // its own step; local `npm test` still builds).
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

    bareRepo = path.join(temporaryHome, 'fixtures', 'source.git');
    await fs.ensureDir(path.dirname(bareRepo));
    execFileSync('git', ['init', '--bare', bareRepo], {
      env: cliEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe']
    });
  });

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => fs.remove(directory)));
  });

  it('clones a local bare repo with an explicit --identity, binds it, updates the registry, and reports the exact JSON payload', async () => {
    await createIdentity('work', 'work@example.com', 'Work User');
    const dest = path.join(temporaryHome, 'clone-dest');

    const result = runCli(['clone', bareRepo, dest, '--identity', 'work', '--json']);

    expect(result.status).toBe(0);
    const parsed = parseSoleJsonObject(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(Object.keys(parsed.data).sort()).toEqual(['bound', 'cloned', 'identity', 'reason', 'url'].sort());
    expect(parsed.data).toEqual({
      cloned: dest,
      url: bareRepo,
      identity: 'work',
      reason: 'flag',
      bound: true
    });

    expect(await fs.pathExists(path.join(dest, '.git'))).toBe(true);
    // Real git, run INSIDE the fresh clone, resolving the DSS binding.
    expect(runGit(dest, ['config', 'dss.space'])).toBe('work');
    expect(runGit(dest, ['config', 'user.email'])).toBe('work@example.com');

    const storeConfig = await fs.readJson(path.join(temporaryHome, '.dss', 'spaces', 'config.json'));
    expect(storeConfig.bindings).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: dest, identity: 'work' })])
    );
  });

  it('defaults the destination to ./<repoName> (basename of the URL minus .git) when no directory is given', async () => {
    await createIdentity('work', 'work@example.com', 'Work User');

    const result = runCli(['clone', bareRepo, '--identity', 'work', '--json']);

    expect(result.status).toBe(0);
    const parsed = parseSoleJsonObject(result.stdout);
    const expectedDest = path.join(temporaryHome, 'source');
    expect(parsed.data.cloned).toBe(expectedDest);
    expect(await fs.pathExists(path.join(expectedDest, '.git'))).toBe(true);
  });

  it('a directory rule matching the destination picks the ruled identity automatically (reason: "rule"), no --identity needed', async () => {
    await createIdentity('work', 'work@example.com', 'Work User');
    await createIdentity('personal', 'personal@example.com', 'Personal User');
    const ruleParent = path.join(temporaryHome, 'code');
    await fs.ensureDir(ruleParent);
    const ruleResult = runCli(['rule', 'add', ruleParent, 'personal', '--json']);
    expect(ruleResult.status).toBe(0);

    const dest = path.join(ruleParent, 'project');
    const result = runCli(['clone', bareRepo, dest, '--json']);

    expect(result.status).toBe(0);
    const parsed = parseSoleJsonObject(result.stdout);
    expect(parsed.data.identity).toBe('personal');
    expect(parsed.data.reason).toBe('rule');
    expect(runGit(dest, ['config', 'user.email'])).toBe('personal@example.com');
  });

  it('fails (exit 1) when the destination already exists', async () => {
    await createIdentity('work', 'work@example.com', 'Work User');
    const dest = path.join(temporaryHome, 'clone-dest');
    await fs.ensureDir(dest);

    const result = runCli(['clone', bareRepo, dest, '--identity', 'work', '--json']);

    expect(result.status).toBe(1);
    const parsed = parseSoleJsonObject(result.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.message).toContain('already exists');
  });

  it('fails with exit code 2 (usage error) for an unrecognized URL', () => {
    const result = runCli(['clone', 'nonsense', 'dest', '--json']);

    expect(result.status).toBe(2);
    const parsed = parseSoleJsonObject(result.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.message).toContain('Unrecognized Git URL');
  });

  it('fails with exit code 2 when the required url positional is missing', () => {
    const result = runCli(['clone']);

    expect(result.status).toBe(2);
  });

  it('fails with exit code 2 (non-interactive, no flag/rule/host match) when --identity is omitted and several identities exist', async () => {
    await createIdentity('work', 'work@example.com', 'Work User');
    await createIdentity('personal', 'personal@example.com', 'Personal User');
    const dest = path.join(temporaryHome, 'clone-dest');

    const result = runCli(['clone', bareRepo, dest, '--json']);

    expect(result.status).toBe(2);
    const parsed = parseSoleJsonObject(result.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.message).toContain('--identity');
    expect(await fs.pathExists(dest)).toBe(false);
  });

  it('fails (exit 1) when --identity names an identity that does not exist', async () => {
    await createIdentity('work', 'work@example.com', 'Work User');
    const dest = path.join(temporaryHome, 'clone-dest');

    const result = runCli(['clone', bareRepo, dest, '--identity', 'ghost', '--json']);

    expect(result.status).toBe(1);
    const parsed = parseSoleJsonObject(result.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.message).toContain('was not found');
  });
});
