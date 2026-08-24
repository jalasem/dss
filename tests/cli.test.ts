import { execSync, spawnSync } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs-extra';

const CLI_PATH = path.join(__dirname, '../build/index.js');

describe('CLI Integration Tests', () => {
  beforeAll(async () => {
    // See tests/nonInteractiveCli.test.ts's beforeAll for why this is
    // skippable (review finding #5) — CI sets DSS_SKIP_TEST_BUILD=1 since
    // it already builds as its own step; local `npm test` still builds.
    if (process.env.DSS_SKIP_TEST_BUILD === '1') return;
    // Build the project before running integration tests
    try {
      execSync('npm run build', { cwd: path.join(__dirname, '..') });
    } catch (error) {
      console.error('Failed to build project:', error);
      throw error;
    }
  });

  describe('CLI Commands', () => {
    it('should show help when no command is provided', () => {
      try {
        const output = execSync(`node ${CLI_PATH} --help`, { encoding: 'utf8' });
        expect(output).toContain('Dev Spaces Switcher (DSS)');
        expect(output).toContain('new');
        expect(output).toContain('ls');
        expect(output).toContain('use');
        expect(output).toContain('rm');
        expect(output).toContain('edit');
        expect(output).toContain('doctor');
      } catch (error) {
        // Help might exit with non-zero code, that's OK
        expect((error as any).stdout).toContain('Dev Spaces Switcher (DSS)');
      }
    });

    it('should show command help for individual (new primary) commands', () => {
      const commands = ['new', 'ls', 'use', 'rm', 'edit', 'doctor'];

      commands.forEach(cmd => {
        try {
          const output = execSync(`node ${CLI_PATH} ${cmd} --help`, { encoding: 'utf8' });
          expect(output).toContain(cmd);
        } catch (error) {
          // Help might exit with non-zero code, that's OK
          expect((error as any).stdout).toContain(cmd);
        }
      });
    });

    it('hides legacy aliases from the top-level --help listing, but their own --help still works', () => {
      const output = execSync(`node ${CLI_PATH} --help`, { encoding: 'utf8' });
      // The top-level command list should not advertise the deprecated names.
      expect(output).not.toMatch(/^\s+add\s/m);
      expect(output).not.toMatch(/^\s+list\s/m);
      expect(output).not.toMatch(/^\s+switch\s/m);

      // But the alias command itself is still registered and reachable.
      const switchHelp = execSync(`node ${CLI_PATH} switch --help`, { encoding: 'utf8' });
      expect(switchHelp).toContain('switch');
    });

    it('invoking a legacy alias ("list") prints a deprecation warning to stderr AND actually runs listSpaces (not just a clean exit)', async () => {
      // Sandboxed HOME with a known space: proves delegation via a real,
      // content-specific side effect (the space table listSpaces prints),
      // not merely that the process exited without error.
      const temporaryHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-cli-alias-'));
      try {
        await fs.outputJson(path.join(temporaryHome, '.dss', 'spaces', 'config.json'), {
          spaces: [{ name: 'alias-proof-space', email: 'proof@example.com', userName: 'Proof', sshKeyPath: '' }]
        });

        const result = spawnSync(
          process.execPath,
          [CLI_PATH, 'list'],
          { encoding: 'utf8', env: { ...process.env, HOME: temporaryHome } }
        );

        // Delegation proof: listSpaces' actual output.
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Your Identities');
        expect(result.stdout).toContain('alias-proof-space');
        // Deprecation-warning proof.
        expect(result.stderr).toContain('"dss list" is deprecated');
        expect(result.stderr).toContain('Use "dss ls"');
      } finally {
        await fs.remove(temporaryHome);
      }
    });

    it('cut commands (batch, bulk, onboard) no longer exist', () => {
      for (const cmd of ['batch', 'bulk', 'onboard']) {
        const result = spawnSync(
          process.execPath,
          [CLI_PATH, cmd],
          { encoding: 'utf8' }
        );
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('unknown command');
      }
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid commands gracefully', () => {
      try {
        execSync(`node ${CLI_PATH} invalid-command`, { encoding: 'utf8', stdio: 'pipe' });
      } catch (error) {
        expect((error as any).stderr || (error as any).stdout).toContain('unknown command');
      }
    });
  });

  describe('Version Check', () => {
    it('should display version information', () => {
      try {
        const output = execSync(`node ${CLI_PATH} --version`, { encoding: 'utf8' });
        expect(output).toMatch(/\d+\.\d+\.\d+/);
      } catch (error) {
        // Version might be in stderr
        expect((error as any).stdout || (error as any).stderr).toMatch(/\d+\.\d+\.\d+/);
      }
    });
  });
});