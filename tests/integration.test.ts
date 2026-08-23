import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs-extra';
import os from 'os';

describe('Integration Tests', () => {
  const CLI_PATH = path.join(__dirname, '../build/index.js');
  let testHomeDir: string;
  let originalHomeDir: string;

  beforeAll(() => {
    // Build the project
    execSync('npm run build', { cwd: path.join(__dirname, '..') });
    
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
    it('should show help when no arguments provided', () => {
      try {
        const result = execSync(`node ${CLI_PATH}`, { 
          encoding: 'utf8',
          stdio: 'pipe' 
        });
        expect(result).toContain('Usage:');
      } catch (error: any) {
        // Help command might exit with non-zero code
        const output = error.stdout || error.stderr || '';
        expect(output).toContain('Usage:');
      }
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
      const commands = ['add', 'list', 'switch', 'remove', 'edit', 'test'];
      
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
        const result = execSync(`node ${CLI_PATH} list`, { 
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
    it('should handle list command when no spaces exist', () => {
      try {
        const result = execSync(`node ${CLI_PATH} list`, { 
          encoding: 'utf8',
          stdio: 'pipe',
          env: { ...process.env, HOME: testHomeDir }
        });
        expect(result).toMatch(/no spaces|empty|⚠️/i);
      } catch (error: any) {
        const output = error.stdout || error.stderr || '';
        expect(output).toMatch(/no spaces|empty|⚠️/i);
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