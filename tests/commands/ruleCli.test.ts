import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

// `dss rule add|ls|rm` (Phase 5 · Task 1): directory rules compiled to a
// native git `includeIf`. CLI-level (real spawned process) coverage,
// including the mandatory end-to-end proof that git itself — not DSS —
// resolves the ruled identity through the include chain when run inside a
// ruled directory.

const CLI_PATH = path.join(__dirname, '../../build/index.js');

describe('dss rule add|ls|rm CLI', () => {
  const temporaryDirectories: string[] = [];
  let temporaryHome: string;

  async function createTemporaryDirectory(): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-rule-cli-'));
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
    // -y makes the trailing "switch to it?" confirm always affirm; without
    // it, that confirm is optional and silently declines in JSON mode
    // (isNonInteractive() is true) — exactly the lever this suite uses to
    // create a SECOND identity without disturbing which one is active.
    if (switchToIt) args.push('-y');
    const result = runCli(args);
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
    await createIdentity('work', 'work@example.com', 'Work User', true);
  });

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => fs.remove(directory)));
  });

  describe('dss rule add', () => {
    it('adds a rule, writes the identity gitconfig, and reports { added, rules } in --json', async () => {
      const ruleDir = path.join(temporaryHome, 'code', 'acme');
      await fs.ensureDir(ruleDir);
      const canonicalDir = await fs.realpath(ruleDir);

      const result = runCli(['rule', 'add', ruleDir, 'work', '--json']);

      expect(result.status).toBe(0);
      const parsed = parseSoleJsonObject(result.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.data).toEqual({ added: { dir: canonicalDir, identity: 'work' }, rules: 1 });

      expect(await fs.pathExists(path.join(temporaryHome, '.dss', 'identities', 'work.gitconfig'))).toBe(true);
      const rulesFile = await fs.readFile(path.join(temporaryHome, '.dss', 'rules.gitconfig'), 'utf8');
      expect(rulesFile).toContain(`[includeIf "gitdir:${canonicalDir}/"]`);
    });

    it('a directory containing a space is added, quoted correctly, and actually resolved by real git (Minor fix round)', async () => {
      const ruleDir = path.join(temporaryHome, 'code', 'my client');
      await fs.ensureDir(ruleDir);
      const repoDir = path.join(ruleDir, 'project');
      await fs.ensureDir(repoDir);
      runGit(repoDir, ['init']);

      const result = runCli(['rule', 'add', ruleDir, 'work', '--json']);

      expect(result.status).toBe(0);
      const parsed = parseSoleJsonObject(result.stdout);
      expect(parsed.data.added.dir).toBe(await fs.realpath(ruleDir));

      // Load-bearing: real git, not DSS, resolving a space-containing
      // includeIf gitdir pattern correctly.
      expect(runGit(repoDir, ['config', '--get', 'user.email'])).toBe('work@example.com');
    });

    it('expands ~ in the directory argument', async () => {
      await fs.ensureDir(path.join(temporaryHome, 'code'));
      const expected = await fs.realpath(path.join(temporaryHome, 'code'));

      const result = runCli(['rule', 'add', path.join('~', 'code'), 'work', '--json']);

      expect(result.status).toBe(0);
      const parsed = parseSoleJsonObject(result.stdout);
      expect(parsed.data.added.dir).toBe(expected);
    });

    it('fails (exit 1) for an unknown identity', async () => {
      const ruleDir = path.join(temporaryHome, 'code', 'acme');
      await fs.ensureDir(ruleDir);

      const result = runCli(['rule', 'add', ruleDir, 'does-not-exist', '--json']);

      expect(result.status).toBe(1);
      const parsed = parseSoleJsonObject(result.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error.message).toContain('was not found');
    });

    it('fails (exit 1) for a directory that does not exist', async () => {
      const result = runCli(['rule', 'add', path.join(temporaryHome, 'does-not-exist'), 'work', '--json']);

      expect(result.status).toBe(1);
      const parsed = parseSoleJsonObject(result.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error.message).toContain('does not exist');
    });

    it('fails (exit 1) when the path is a file, not a directory', async () => {
      const filePath = path.join(temporaryHome, 'a-file');
      await fs.outputFile(filePath, 'not a directory');

      const result = runCli(['rule', 'add', filePath, 'work', '--json']);

      expect(result.status).toBe(1);
      const parsed = parseSoleJsonObject(result.stdout);
      expect(parsed.error.message).toContain('Not a directory');
    });

    it('fails with exit code 2 (usage error) when a required positional is missing', () => {
      const missingIdentity = spawnSync(process.execPath, [CLI_PATH, 'rule', 'add', temporaryHome], {
        cwd: temporaryHome,
        encoding: 'utf8',
        env: cliEnvironment(),
        input: ''
      });
      expect(missingIdentity.status).toBe(2);

      const missingBoth = spawnSync(process.execPath, [CLI_PATH, 'rule', 'add'], {
        cwd: temporaryHome,
        encoding: 'utf8',
        env: cliEnvironment(),
        input: ''
      });
      expect(missingBoth.status).toBe(2);
    });

    it('upserts by canonical directory — adding the same dir again replaces the identity, not duplicates the rule', async () => {
      const ruleDir = path.join(temporaryHome, 'code', 'acme');
      await fs.ensureDir(ruleDir);
      await createIdentity('personal', 'personal@example.com', 'Personal User', false);

      const first = runCli(['rule', 'add', ruleDir, 'work', '--json']);
      expect(first.status).toBe(0);
      const second = runCli(['rule', 'add', ruleDir, 'personal', '--json']);
      expect(second.status).toBe(0);

      const parsed = parseSoleJsonObject(second.stdout);
      expect(parsed.data.rules).toBe(1);

      const ls = runCli(['rule', 'ls', '--json']);
      const lsParsed = parseSoleJsonObject(ls.stdout);
      expect(lsParsed.data.rules).toHaveLength(1);
      expect(lsParsed.data.rules[0].identity).toBe('personal');
    });
  });

  describe('dss rule ls', () => {
    it('reports an empty list in --json when there are no rules', async () => {
      const result = runCli(['rule', 'ls', '--json']);

      expect(result.status).toBe(0);
      const parsed = parseSoleJsonObject(result.stdout);
      expect(parsed.data).toEqual({ rules: [] });
    });

    it('lists rules (dir -> identity) in --json', async () => {
      const ruleDir = path.join(temporaryHome, 'code', 'acme');
      await fs.ensureDir(ruleDir);
      const canonicalDir = await fs.realpath(ruleDir);
      runCli(['rule', 'add', ruleDir, 'work']);

      const result = runCli(['rule', 'ls', '--json']);

      const parsed = parseSoleJsonObject(result.stdout);
      expect(parsed.data.rules).toEqual([{ dir: canonicalDir, identity: 'work' }]);
    });

    it('renders a PLAIN (non-TTY), tab-separated table — no ANSI/box/unicode leakage', async () => {
      const ruleDir = path.join(temporaryHome, 'code', 'acme');
      await fs.ensureDir(ruleDir);
      const canonicalDir = await fs.realpath(ruleDir);
      runCli(['rule', 'add', ruleDir, 'work']);

      const result = runCli(['rule', 'ls']);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(['Directory', 'Identity'].join('\t'));
      expect(result.stdout).toContain([canonicalDir, 'work'].join('\t'));
      // eslint-disable-next-line no-control-regex
      expect(result.stdout).not.toMatch(/\x1b\[/); // no ANSI escapes
    });
  });

  describe('dss rule rm', () => {
    it('removes a rule and reports { removed, rules } in --json', async () => {
      const ruleDir = path.join(temporaryHome, 'code', 'acme');
      await fs.ensureDir(ruleDir);
      const canonicalDir = await fs.realpath(ruleDir);
      runCli(['rule', 'add', ruleDir, 'work']);

      const result = runCli(['rule', 'rm', ruleDir, '--json']);

      expect(result.status).toBe(0);
      const parsed = parseSoleJsonObject(result.stdout);
      expect(parsed.data).toEqual({ removed: canonicalDir, rules: 0 });

      const rulesFile = await fs.readFile(path.join(temporaryHome, '.dss', 'rules.gitconfig'), 'utf8');
      expect(rulesFile).toBe('');
    });

    it('fails (exit 1) when there is no rule for the given directory', async () => {
      const result = runCli(['rule', 'rm', temporaryHome, '--json']);

      expect(result.status).toBe(1);
      const parsed = parseSoleJsonObject(result.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error.message).toContain('No directory rule found');
    });
  });

  describe('dashboard integration ("dss --json" source: "rule")', () => {
    it('reports source: "rule" (and the ruled identity) for an unbound, ruled directory', async () => {
      await createIdentity('personal', 'personal@example.com', 'Personal User', false);
      const ruledDir = path.join(temporaryHome, 'code', 'acme');
      await fs.ensureDir(ruledDir);
      runCli(['rule', 'add', ruledDir, 'personal']);

      const result = runCli(['--json'], ruledDir);

      expect(result.status).toBe(0);
      const parsed = parseSoleJsonObject(result.stdout);
      expect(parsed.data.source).toBe('rule');
      expect(parsed.data.identity.name).toBe('personal');
    });

    it('reports source: "global" outside any configured rule', async () => {
      await createIdentity('personal', 'personal@example.com', 'Personal User', false);
      const ruledDir = path.join(temporaryHome, 'code', 'acme');
      await fs.ensureDir(ruledDir);
      runCli(['rule', 'add', ruledDir, 'personal']);

      const result = runCli(['--json'], temporaryHome);

      expect(result.status).toBe(0);
      const parsed = parseSoleJsonObject(result.stdout);
      expect(parsed.data.source).toBe('global');
      expect(parsed.data.identity.name).toBe('work');
    });
  });

  // ---------------------------------------------------------------------
  // MANDATORY end-to-end proof: a REAL `git config` invocation, run INSIDE
  // a ruled directory (via GIT_CONFIG_GLOBAL pointed at this sandbox's own
  // global gitconfig), must resolve the RULED identity — not DSS
  // reporting it, git itself walking the includeIf chain DSS wrote.
  // ---------------------------------------------------------------------
  describe('end-to-end: git itself resolves the ruled identity through the include chain', () => {
    it('a ruled directory resolves to the ruled identity; an unruled directory keeps the global default', async () => {
      // beforeEach already created + switched to "work" (global active).
      // Create a second identity, "personal", WITHOUT switching to it, then
      // rule a directory tree to "personal" — this is the strongest proof
      // shape: the ruled directory must resolve to something DIFFERENT
      // from the global default, not just "whichever identity happens to
      // be active everywhere".
      await createIdentity('personal', 'personal@example.com', 'Personal User', false);

      const ruledParent = path.join(temporaryHome, 'code', 'acme');
      const ruledRepo = path.join(ruledParent, 'project');
      await fs.ensureDir(ruledRepo);
      runGit(ruledRepo, ['init']);

      const unruledRepo = path.join(temporaryHome, 'elsewhere', 'project');
      await fs.ensureDir(unruledRepo);
      runGit(unruledRepo, ['init']);

      const addResult = runCli(['rule', 'add', ruledParent, 'personal', '--json']);
      expect(addResult.status).toBe(0);

      // The load-bearing assertions: real `git config --get`, executed by
      // the real git binary INSIDE each repository, with GIT_CONFIG_GLOBAL
      // pointed at the same global gitconfig `dss use`/`dss rule add` wrote
      // their include.path entries into.
      expect(runGit(ruledRepo, ['config', '--get', 'user.email'])).toBe('personal@example.com');
      expect(runGit(ruledRepo, ['config', '--get', 'user.name'])).toBe('Personal User');

      expect(runGit(unruledRepo, ['config', '--get', 'user.email'])).toBe('work@example.com');
      expect(runGit(unruledRepo, ['config', '--get', 'user.name'])).toBe('Work User');

      // Include order: active.gitconfig's entry (added by the earlier `dss
      // new -y` switch) precedes rules.gitconfig's (added by `dss rule
      // add` afterwards) — the natural, documented ordering (infra/git.ts's
      // ensureGlobalInclude) that lets the rule override the global switch.
      const includes = runGit(temporaryHome, ['config', '--global', '--get-all', 'include.path']).split('\n');
      const activeIndex = includes.findIndex(entry => entry.endsWith('active.gitconfig'));
      const rulesIndex = includes.findIndex(entry => entry.endsWith('rules.gitconfig'));
      expect(activeIndex).toBeGreaterThanOrEqual(0);
      expect(rulesIndex).toBeGreaterThan(activeIndex);
    });

    it('removing the rule reverts the previously-ruled directory to the global default', async () => {
      await createIdentity('personal', 'personal@example.com', 'Personal User', false);

      const ruledParent = path.join(temporaryHome, 'code', 'acme');
      const ruledRepo = path.join(ruledParent, 'project');
      await fs.ensureDir(ruledRepo);
      runGit(ruledRepo, ['init']);

      runCli(['rule', 'add', ruledParent, 'personal']);
      expect(runGit(ruledRepo, ['config', '--get', 'user.email'])).toBe('personal@example.com');

      const rmResult = runCli(['rule', 'rm', ruledParent, '--json']);
      expect(rmResult.status).toBe(0);

      expect(runGit(ruledRepo, ['config', '--get', 'user.email'])).toBe('work@example.com');
    });

    // Review fix round (Important #1): getGitUser now passes `--includes`
    // to `git config --global`, so `dss doctor`'s "Rule drift" check must
    // actually resolve a real match/mismatch verdict here — before the
    // fix, this same setup reported "unable to check" instead (the
    // include chain was never expanded).
    it('"dss doctor" run from inside a ruled directory reports Rule drift: matches (not "unable to check")', async () => {
      await createIdentity('personal', 'personal@example.com', 'Personal User', false);
      const ruledParent = path.join(temporaryHome, 'code', 'acme');
      const ruledRepo = path.join(ruledParent, 'project');
      await fs.ensureDir(ruledRepo);
      runGit(ruledRepo, ['init']);

      const addResult = runCli(['rule', 'add', ruledParent, 'personal']);
      expect(addResult.status).toBe(0);

      const result = runCli(['doctor', 'personal'], ruledRepo);

      expect(result.stdout).toContain('Directory rule');
      expect(result.stdout).toContain(`${ruledParent} -> personal`);
      expect(result.stdout).not.toContain('unable to check');
      expect(result.stdout).toContain('Rule drift: matches');
      // PLAIN mode renders a success status with no tag — a warning would
      // read "warn: Rule drift: ...".
      const driftLine = result.stdout.split('\n').find(line => line.includes('Rule drift: matches'));
      expect(driftLine).not.toMatch(/^warn:/);
    });

    it('"dss doctor" reports a real Rule drift MISMATCH when the ruled identity\'s gitconfig has drifted from the store', async () => {
      await createIdentity('personal', 'personal@example.com', 'Personal User', false);

      const ruledParent = path.join(temporaryHome, 'code', 'acme');
      const ruledRepo = path.join(ruledParent, 'project');
      await fs.ensureDir(ruledRepo);
      runGit(ruledRepo, ['init']);

      const addResult = runCli(['rule', 'add', ruledParent, 'personal']);
      expect(addResult.status).toBe(0);

      // getGitUser() is deliberately --global-scoped (it must NOT pick up
      // a repo-LOCAL binding override — that's "Repo binding"'s own
      // concern, reported separately), so the realistic way to produce a
      // genuine Rule-drift mismatch is what the check actually guards
      // against: the ruled identity's OWN gitconfig file (~/.dss/identities/
      // personal.gitconfig) having drifted from the store's current values
      // — e.g. a hand-edit, or (pre-Task-5) a missed refresh. Simulate that
      // directly, mirroring how the file could genuinely diverge without
      // going through `dss rule add`/`dss edit`.
      const identityGitconfigPath = path.join(temporaryHome, '.dss', 'identities', 'personal.gitconfig');
      await fs.outputFile(
        identityGitconfigPath,
        '[user]\n\tname = "Stale Name"\n\temail = "stale@example.com"\n'
      );

      const result = runCli(['doctor', 'personal'], ruledRepo);

      expect(result.stdout).toContain('Directory rule');
      expect(result.stdout).toContain(`${ruledParent} -> personal`);
      expect(result.stdout).not.toContain('unable to check');
      // git resolves the STALE file's values (real include-chain
      // resolution), which no longer match the store's "Personal User
      // <personal@example.com>" — a genuine mismatch.
      expect(result.stdout).toContain('Stale Name <stale@example.com>');
      const driftLine = result.stdout.split('\n').find(line => line.includes('Rule drift') && line.includes('Stale Name'));
      expect(driftLine).toMatch(/^warn:/);
    });
  });
});
