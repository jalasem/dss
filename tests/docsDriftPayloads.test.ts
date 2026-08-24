import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

// Review finding #6 (folded minor): docsDrift.test.ts already guards
// AGENTS.md's command/flag *names* against drifting from the real Commander
// program (see that file's "walker vs AGENTS.md" describe block), but
// nothing checked that each recipe's documented `data: { ... }` KEY SET
// still matches what the command actually emits at runtime — that gap is
// exactly what let review finding #2 happen (doctor's hard-failure path
// silently dropping `data` entirely, contradicting AGENTS.md's own doctor
// recipe, went unnoticed by every existing test). This file closes it: run
// each of AGENTS.md's documented recipes for real (spawned CLI, temp HOME)
// and assert the parsed `data` object's key set is EXACTLY what's
// transcribed below from AGENTS.md's "## Recipes" section.
//
// Deliberately a sibling file, not an extension of docsDrift.test.ts itself:
// docsDrift.test.ts is a pure in-process unit suite (no build, no spawn) —
// folding a spawned/build-dependent suite into it would slow down and
// complicate every other test in that file for an unrelated concern. Reuses
// the exact sandbox/build-gate pattern from tests/jsonCli.test.ts.

const CLI_PATH = path.join(__dirname, '../build/index.js');

describe('docs drift: recipe payload shapes (CLI, spawned process)', () => {
  const temporaryDirectories: string[] = [];
  let temporaryHome: string;

  async function createTemporaryDirectory(): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-docs-drift-payloads-'));
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

  function runCli(args: string[], cwd?: string): { stdout: string; stderr: string; status: number | null } {
    const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
      cwd: cwd ?? temporaryHome,
      encoding: 'utf8',
      env: cliEnvironment(),
      input: '',
      timeout: 10000
    });
    return { stdout: result.stdout, stderr: result.stderr, status: result.status };
  }

  function parseSoleJsonObject(stdout: string): any {
    const trimmed = stdout.trim();
    const parsed = JSON.parse(trimmed);
    expect(trimmed).toBe(JSON.stringify(parsed));
    return parsed;
  }

  async function writeConfig(spaces: Array<{ name: string; email: string; userName: string; sshKeyPath?: string; host?: string }>, activeSpace?: string): Promise<void> {
    await fs.outputJson(path.join(temporaryHome, '.dss', 'spaces', 'config.json'), { spaces, activeSpace });
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

  /** Asserts `data`'s own key set is EXACTLY `expectedKeys` (order-independent). */
  function expectDataKeys(data: unknown, expectedKeys: string[]): void {
    expect(data).toBeDefined();
    expect(Object.keys(data as object).sort()).toEqual([...expectedKeys].sort());
  }

  it('dashboard ("dss --json"): data keys match AGENTS.md\'s `{ identity, source, health, identities }`', async () => {
    await writeConfig([{ name: 'x', email: 'x@y.z', userName: 'X', sshKeyPath: '' }], 'x');

    const result = runCli(['--json']);

    expect(result.status).toBe(0);
    const parsed = parseSoleJsonObject(result.stdout);
    expect(parsed.ok).toBe(true);
    expectDataKeys(parsed.data, ['identity', 'source', 'health', 'identities']);
  });

  it('"dss ls --json": data keys match AGENTS.md\'s `{ identities, active }`', async () => {
    await writeConfig([{ name: 'x', email: 'x@y.z', userName: 'X', sshKeyPath: '' }]);

    const result = runCli(['ls', '--json']);

    expect(result.status).toBe(0);
    const parsed = parseSoleJsonObject(result.stdout);
    expect(parsed.ok).toBe(true);
    expectDataKeys(parsed.data, ['identities', 'active']);
  });

  it('"dss new --json": data keys match AGENTS.md\'s `{ created, key, switched }`', async () => {
    await writeConfig([]);

    const result = runCli([
      'new', '--json', '-y',
      '--name', 'wk', '--email', 'wk@x.com', '--user', 'WK', '--host', 'github.com', '--key', 'none'
    ]);

    expect(result.status).toBe(0);
    const parsed = parseSoleJsonObject(result.stdout);
    expect(parsed.ok).toBe(true);
    expectDataKeys(parsed.data, ['created', 'key', 'switched']);
  });

  it('"dss use <name> --json": data keys match AGENTS.md\'s `{ switched, previous }`', async () => {
    await writeConfig([{ name: 'x', email: 'x@y.z', userName: 'X', sshKeyPath: '' }]);

    const result = runCli(['use', 'x', '--json']);

    expect(result.status).toBe(0);
    const parsed = parseSoleJsonObject(result.stdout);
    expect(parsed.ok).toBe(true);
    expectDataKeys(parsed.data, ['switched', 'previous']);
  });

  // Review finding #2's own regression case: a hard-failure doctor run must
  // STILL carry `data` (not just `error`) with exactly the keys AGENTS.md's
  // doctor recipe documents — this is the specific check that would have
  // caught #2 before it shipped.
  it('"dss doctor <name> --json" hard failure: data keys match AGENTS.md\'s `{ identity, checks, summary }`, alongside error', async () => {
    await writeConfig([{ name: 'personal', email: 'p@x.com', userName: 'P', sshKeyPath: '' }]);

    const result = runCli(['doctor', 'personal', '--json']);

    expect(result.status).toBe(1);
    const parsed = parseSoleJsonObject(result.stdout);
    expect(parsed.ok).toBe(false);
    expect(typeof parsed.error.message).toBe('string');
    expectDataKeys(parsed.data, ['identity', 'checks', 'summary']);
  });

  it('"dss key rotate <name> --json -y": data keys match AGENTS.md\'s `{ rotated, key }`', async () => {
    await writeConfig([{ name: 'x', email: 'x@y.z', userName: 'X', sshKeyPath: '' }]);

    const result = runCli(['key', 'rotate', 'x', '-y', '--json']);

    expect(result.status).toBe(0);
    const parsed = parseSoleJsonObject(result.stdout);
    expect(parsed.ok).toBe(true);
    expectDataKeys(parsed.data, ['rotated', 'key']);
  });

  it('"dss config export --json": data keys match AGENTS.md\'s `{ exported, path }`', async () => {
    await writeConfig([{ name: 'x', email: 'x@y.z', userName: 'X', sshKeyPath: '' }]);
    const exportPath = path.join(temporaryHome, 'export.json');

    const result = runCli(['config', 'export', exportPath, '--json']);

    expect(result.status).toBe(0);
    const parsed = parseSoleJsonObject(result.stdout);
    expect(parsed.ok).toBe(true);
    expectDataKeys(parsed.data, ['exported', 'path']);
  });

  it('"dss rule add --json": data keys match AGENTS.md\'s `{ added, rules }`', async () => {
    await writeConfig([{ name: 'work', email: 'work@x.com', userName: 'Work', sshKeyPath: '' }]);
    const ruleDir = await createTemporaryDirectory();

    const result = runCli(['rule', 'add', ruleDir, 'work', '--json']);

    expect(result.status).toBe(0);
    const parsed = parseSoleJsonObject(result.stdout);
    expect(parsed.ok).toBe(true);
    expectDataKeys(parsed.data, ['added', 'rules']);
  });

  it('"dss rule ls --json": data keys match AGENTS.md\'s `{ rules }`', async () => {
    await writeConfig([{ name: 'work', email: 'work@x.com', userName: 'Work', sshKeyPath: '' }]);

    const result = runCli(['rule', 'ls', '--json']);

    expect(result.status).toBe(0);
    const parsed = parseSoleJsonObject(result.stdout);
    expect(parsed.ok).toBe(true);
    expectDataKeys(parsed.data, ['rules']);
  });

  it('"dss rule rm --json": data keys match AGENTS.md\'s `{ removed, rules }`', async () => {
    await writeConfig([{ name: 'work', email: 'work@x.com', userName: 'Work', sshKeyPath: '' }]);
    const ruleDir = await createTemporaryDirectory();
    const addResult = runCli(['rule', 'add', ruleDir, 'work', '--json']);
    expect(addResult.status).toBe(0);

    const result = runCli(['rule', 'rm', ruleDir, '--json']);

    expect(result.status).toBe(0);
    const parsed = parseSoleJsonObject(result.stdout);
    expect(parsed.ok).toBe(true);
    expectDataKeys(parsed.data, ['removed', 'rules']);
  });

  // A LOCAL bare repo as the clone source (file-system path — parseGitUrl's
  // local-path form, host undefined) — see src/core/gitUrl.ts and the
  // AGENTS.md clone recipe's note that a local-path clone skips host
  // matching. Never touches the network, matching this whole file's
  // no-network policy.
  it('"dss clone <local bare repo> --json": data keys match AGENTS.md\'s `{ cloned, url, identity, reason, bound }`', async () => {
    await writeConfig([{ name: 'x', email: 'x@y.z', userName: 'X', sshKeyPath: '' }]);
    const bareRepo = path.join(temporaryHome, 'fixtures', 'source.git');
    await fs.ensureDir(path.dirname(bareRepo));
    execFileSync('git', ['init', '--bare', bareRepo], {
      env: cliEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const dest = path.join(temporaryHome, 'clone-dest');

    const result = runCli(['clone', bareRepo, dest, '--identity', 'x', '--json']);

    expect(result.status).toBe(0);
    const parsed = parseSoleJsonObject(result.stdout);
    expect(parsed.ok).toBe(true);
    expectDataKeys(parsed.data, ['cloned', 'url', 'identity', 'reason', 'bound']);
  });

  it('"dss guard install --json": data keys match AGENTS.md\'s `{ installed }`', async () => {
    const repoDir = path.join(temporaryHome, 'repo');
    await fs.ensureDir(repoDir);
    execFileSync('git', ['init'], { cwd: repoDir, env: cliEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });

    const result = runCli(['guard', 'install', '--json'], repoDir);

    expect(result.status).toBe(0);
    const parsed = parseSoleJsonObject(result.stdout);
    expect(parsed.ok).toBe(true);
    expectDataKeys(parsed.data, ['installed']);
  });

  it('"dss guard check --json": data keys match AGENTS.md\'s `{ ok, expected, effective }`', async () => {
    // `dss new -y` (not writeConfig) so the identity is actually SWITCHED
    // to — writing active.gitconfig and the global include.path entry —
    // otherwise `git config user.email` would resolve to nothing and this
    // would exercise the mismatch (exit 1) path instead of the documented
    // match shape.
    const create = runCli(['new', '--json', '--name', 'work', '--email', 'work@x.com', '--user', 'Work', '--host', 'github.com', '--key', 'none', '-y']);
    expect(create.status).toBe(0);
    const repoDir = path.join(temporaryHome, 'repo');
    await fs.ensureDir(repoDir);
    execFileSync('git', ['init'], { cwd: repoDir, env: cliEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });

    const result = runCli(['guard', 'check', '--json'], repoDir);

    expect(result.status).toBe(0);
    const parsed = parseSoleJsonObject(result.stdout);
    expect(parsed.ok).toBe(true);
    expectDataKeys(parsed.data, ['ok', 'expected', 'effective']);
  });

  it('"dss guard uninstall --json": data keys match AGENTS.md\'s `{ removed }`', async () => {
    const repoDir = path.join(temporaryHome, 'repo');
    await fs.ensureDir(repoDir);
    execFileSync('git', ['init'], { cwd: repoDir, env: cliEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });

    const result = runCli(['guard', 'uninstall', '--json'], repoDir);

    expect(result.status).toBe(0);
    const parsed = parseSoleJsonObject(result.stdout);
    expect(parsed.ok).toBe(true);
    expectDataKeys(parsed.data, ['removed']);
  });

  it('"dss config import --json -y": data keys match AGENTS.md\'s `{ imported, skipped }`', async () => {
    await writeConfig([{ name: 'x', email: 'x@y.z', userName: 'X', sshKeyPath: '' }]);
    const exportPath = path.join(temporaryHome, 'export.json');
    const exportResult = runCli(['config', 'export', exportPath, '--json']);
    expect(exportResult.status).toBe(0);

    // Importing into the SAME store: "x" already exists, so this exercises
    // the imported:0/skipped:["x"] shape without needing a second store.
    const result = runCli(['config', 'import', exportPath, '-y', '--json']);

    expect(result.status).toBe(0);
    const parsed = parseSoleJsonObject(result.stdout);
    expect(parsed.ok).toBe(true);
    expectDataKeys(parsed.data, ['imported', 'skipped']);
  });

  // `dss prompt` (Phase 5 · Task 4): AGENTS.md's Notes section documents its
  // payload shape as `{ identity: string | null, source: "bound" | "rule" |
  // "global" | null }` rather than a full "## Recipes" entry (it's a
  // human-shell command, not something an agent drives) — still covered
  // here so the documented key set can't silently drift from what the
  // spawned CLI actually emits, matching every other command in this file.
  it('"dss prompt --json": data keys match AGENTS.md\'s `{ identity, source }` when an identity resolves', async () => {
    const create = runCli(['new', '--json', '--name', 'work', '--email', 'work@x.com', '--user', 'Work', '--host', 'github.com', '--key', 'none', '-y']);
    expect(create.status).toBe(0);

    const result = runCli(['prompt', '--json']);

    expect(result.status).toBe(0);
    const parsed = parseSoleJsonObject(result.stdout);
    expect(parsed.ok).toBe(true);
    expectDataKeys(parsed.data, ['identity', 'source']);
    expect(parsed.data).toEqual({ identity: 'work', source: 'global' });
  });

  it('"dss prompt --json": data keys match AGENTS.md\'s `{ identity, source }` when nothing applies (both null)', async () => {
    await writeConfig([]);

    const result = runCli(['prompt', '--json']);

    expect(result.status).toBe(0);
    const parsed = parseSoleJsonObject(result.stdout);
    expect(parsed.ok).toBe(true);
    expectDataKeys(parsed.data, ['identity', 'source']);
    expect(parsed.data).toEqual({ identity: null, source: null });
  });
});
