import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs-extra';

const CLI_PATH = path.join(__dirname, '../build/index.js');

describe('CLI Integration Tests', () => {
  beforeAll(async () => {
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
        expect(output).toContain('add');
        expect(output).toContain('list');
        expect(output).toContain('switch');
        expect(output).toContain('remove');
        expect(output).toContain('edit');
        expect(output).toContain('test');
      } catch (error) {
        // Help might exit with non-zero code, that's OK
        expect((error as any).stdout).toContain('Dev Spaces Switcher (DSS)');
      }
    });

    it('should show command help for individual commands', () => {
      const commands = ['add', 'list', 'switch', 'remove', 'edit', 'test'];
      
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