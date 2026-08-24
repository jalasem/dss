import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs-extra';
import os from 'os';

describe('Integration Tests', () => {
  const CLI_PATH = path.join(__dirname, '../build/index.js');
  let testHomeDir: string;
  let originalHomeDir: string;

  beforeAll(() => {
    // See tests/nonInteractiveCli.test.ts's beforeAll for why this is
    // skippable (review finding #5) — CI sets DSS_SKIP_TEST_BUILD=1 since
    // it already builds as its own step; local `npm test` still builds.
    if (process.env.DSS_SKIP_TEST_BUILD !== '1') {
      // Build the project
      execSync('npm run build', { cwd: path.join(__dirname, '..') });
    }

    // Create a temporary home directory for testing
    testHomeDir = path.join(os.tmpdir(), 'dss-test-' + Date.now());
    fs.ensureDirSync(testHomeDir);
    originalHomeDir = os.homedir();
    
    // Mock the home directory
    jest.spyOn(os, 'homedir').mockReturnValue(testHomeDir);
  });

  afterAll(() => {
    // Restore original home directory
    jest.restoreAllMocks();
    
    // Clean up test directory
    fs.removeSync(testHomeDir);
  });

  describe('CLI Help', () => {
    // Bare `dss` (no args at all) runs the context dashboard (Phase 3 ·
    // Task 3), not the old help dump — `dss --help` (tested separately in
    // tests/cli.test.ts) is what shows "Usage:" now. With zero identities
    // in this test's fresh home directory, the dashboard delegates to the
    // first-run flow instead.
    it('runs the first-run flow (not a help dump) when no arguments are provided and no identities exist yet', () => {
      // jest.spyOn(os, 'homedir') (set in beforeAll) only patches this test
      // process's own Node module — it does NOT cross into the spawned
      // child process, so HOME must be overridden explicitly here too, or
      // this would read the real developer machine's ~/.dss config instead
      // of the fresh, empty testHomeDir.
      const result = execSync(`node ${CLI_PATH}`, {
        encoding: 'utf8',
        stdio: 'pipe',
        env: { ...process.env, HOME: testHomeDir }
      });
      expect(result).toContain('Dev Spaces Switcher');
      expect(result).not.toContain('Usage:');
    });

    it('should show version information', () => {
      try {
        const result = execSync(`node ${CLI_PATH} --version`, { 
          encoding: 'utf8',
          stdio: 'pipe' 
        });
        expect(result).toMatch(/\d+\.\d+\.\d+/);
      } catch (error: any) {
        const output = error.stdout || error.stderr || '';
        expect(output).toMatch(/\d+\.\d+\.\d+/);
      }
    });

    it('should show help for specific commands', () => {
      const commands = ['new', 'ls', 'use', 'rm', 'edit', 'test'];
      
      commands.forEach(command => {
        try {
          const result = execSync(`node ${CLI_PATH} ${command} --help`, { 
            encoding: 'utf8',
            stdio: 'pipe' 
          });
          expect(result).toContain(command);
        } catch (error: any) {
          const output = error.stdout || error.stderr || '';
          expect(output).toContain(command);
        }
      });
    });
  });

  describe('CLI Error Handling', () => {
    it('should handle unknown commands gracefully', () => {
      try {
        execSync(`node ${CLI_PATH} unknown-command`, { 
          encoding: 'utf8',
          stdio: 'pipe' 
        });
      } catch (error: any) {
        const output = error.stdout || error.stderr || '';
        expect(output).toMatch(/unknown|invalid|not found/i);
      }
    });
  });

  describe('Configuration Management', () => {
    it('should create configuration directory structure', async () => {
      const configDir = path.join(testHomeDir, '.dss', 'spaces');
      
      // The config should be created when we run any command
      try {
        const result = execSync(`node ${CLI_PATH} ls`, {
          encoding: 'utf8',
          stdio: 'pipe',
          env: { ...process.env, HOME: testHomeDir }
        });
      } catch (error) {
        // Command might fail due to no spaces, but config should be created
      }
      
      // Check if config structure exists
      expect(fs.existsSync(configDir)).toBe(true);
    });
  });

  describe('Space Operations', () => {
    it('runs the first-run flow (welcome + creation prompt) when no spaces exist', () => {
      // Piped stdin closes immediately (no `input` supplied), so the
      // creation prompt's safeConfirm() treats it as declined rather than
      // hanging — see src/commands/prompts.ts's isPromptExitError handling.
      try {
        const result = execSync(`node ${CLI_PATH} ls`, {
          encoding: 'utf8',
          stdio: 'pipe',
          env: { ...process.env, HOME: testHomeDir }
        });
        expect(result).toMatch(/dev spaces switcher/i);
        expect(result).toContain('dss new');
      } catch (error: any) {
        const output = error.stdout || error.stderr || '';
        expect(output).toMatch(/dev spaces switcher/i);
      }
    });
  });

  describe('Performance', () => {
    it('should respond to help commands quickly', () => {
      const startTime = Date.now();
      
      try {
        execSync(`node ${CLI_PATH} --help`, { 
          encoding: 'utf8',
          stdio: 'pipe' 
        });
      } catch (error) {
        // Help might exit with non-zero code
      }
      
      const endTime = Date.now();
      const duration = endTime - startTime;
      
      // Should complete within 5 seconds
      expect(duration).toBeLessThan(5000);
    });
  });
});