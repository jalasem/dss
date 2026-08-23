import { execFile, spawn } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs-extra';
import os from 'os';
import { confirm } from '@inquirer/prompts';
import {
  setGitHubSSHKey,
  removeSSHKeyFromAgent,
  testGithubAccess,
  copyToClipboard
} from '../../src/utils/index';

jest.mock('child_process');
jest.mock('fs-extra');
jest.mock('@inquirer/prompts', () => ({
  confirm: jest.fn(),
  select: jest.fn(),
  input: jest.fn()
}));

const mockExecFile = execFile as unknown as jest.MockedFunction<typeof execFile>;
const mockSpawn = spawn as unknown as jest.MockedFunction<typeof spawn>;
const mockFs = fs as jest.Mocked<typeof fs>;
const mockConfirm = confirm as jest.MockedFunction<typeof confirm>;

function createMockChildProcess() {
  const child: any = new EventEmitter();
  const stdin: any = new EventEmitter();
  stdin.write = jest.fn();
  stdin.end = jest.fn();
  child.stdin = stdin;
  return child;
}

describe('Utility Functions', () => {
  const mockHomeDir = '/mock/home';
  const mockSshKeyPath = '/mock/home/.dss/spaces/test-space/id_rsa';
  const mockSshConfigPath = '/mock/home/.ssh/config';

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(os, 'homedir').mockReturnValue(mockHomeDir);
    mockConfirm.mockResolvedValue(false as never);
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  describe('setGitHubSSHKey', () => {
    it('should create SSH config for GitHub with new key', async () => {
      (mockFs.ensureFile as jest.Mock).mockResolvedValue(undefined);
      (mockFs.readFile as unknown as jest.Mock).mockResolvedValue('');
      (mockFs.writeFile as unknown as jest.Mock).mockResolvedValue(undefined);

      await setGitHubSSHKey(mockSshKeyPath);

      expect(mockFs.ensureFile).toHaveBeenCalledWith(mockSshConfigPath);
      expect(mockFs.writeFile).toHaveBeenCalledWith(
        mockSshConfigPath,
        expect.stringContaining('Host github.com')
      );
      expect(mockFs.writeFile).toHaveBeenCalledWith(
        mockSshConfigPath,
        expect.stringContaining(mockSshKeyPath)
      );
    });

    it('should replace existing GitHub config', async () => {
      const existingConfig = `Host github.com
  HostName github.com
  User git
  IdentityFile /old/path/id_rsa
  IdentitiesOnly yes

Host other.com
  HostName other.com
  User git`;

      (mockFs.ensureFile as jest.Mock).mockResolvedValue(undefined);
      (mockFs.readFile as unknown as jest.Mock).mockResolvedValue(existingConfig);
      (mockFs.writeFile as unknown as jest.Mock).mockResolvedValue(undefined);

      await setGitHubSSHKey(mockSshKeyPath);

      expect(mockFs.writeFile).toHaveBeenCalledWith(
        mockSshConfigPath,
        expect.stringContaining(mockSshKeyPath)
      );
      expect(mockFs.writeFile).toHaveBeenCalledWith(
        mockSshConfigPath,
        expect.stringContaining('Host other.com')
      );
    });

    it('should handle errors gracefully', async () => {
      (mockFs.ensureFile as jest.Mock).mockRejectedValue(new Error('Permission denied'));

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      await setGitHubSSHKey(mockSshKeyPath);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to update SSH config for GitHub: Permission denied')
      );

      consoleSpy.mockRestore();
    });
  });

  describe('removeSSHKeyFromAgent', () => {
    it('should remove SSH key from agent successfully', async () => {
      (mockExecFile as unknown as jest.Mock).mockImplementation(
        (_file: string, _args: string[], callback: any) => {
          callback(null, { stdout: '', stderr: '' });
          return {} as any;
        }
      );

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      await removeSSHKeyFromAgent(mockSshKeyPath);

      expect(mockExecFile).toHaveBeenCalledWith(
        'ssh-add',
        ['-d', mockSshKeyPath],
        expect.any(Function)
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('SSH key removed from ssh-agent successfully.')
      );

      consoleSpy.mockRestore();
    });

    it('should handle errors when removing SSH key', async () => {
      (mockExecFile as unknown as jest.Mock).mockImplementation(
        (_file: string, _args: string[], callback: any) => {
          callback(new Error('Key not found'));
          return {} as any;
        }
      );

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      await removeSSHKeyFromAgent(mockSshKeyPath);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error removing SSH key from ssh-agent: Key not found')
      );

      consoleSpy.mockRestore();
    });

    it('passes an SSH key path containing a space to ssh-add as a single execFile argument (regression)', async () => {
      const spacedKeyPath = '/tmp/my dir/id_rsa';
      (mockExecFile as unknown as jest.Mock).mockImplementation(
        (_file: string, _args: string[], callback: any) => {
          callback(null, { stdout: '', stderr: '' });
          return {} as any;
        }
      );

      await removeSSHKeyFromAgent(spacedKeyPath);

      expect(mockExecFile).toHaveBeenCalledWith(
        'ssh-add',
        ['-d', spacedKeyPath],
        expect.any(Function)
      );
    });
  });

  describe('testGithubAccess', () => {
    it('passes an SSH key path containing a space to ssh-add as a single execFile argument (regression)', async () => {
      const spacedKeyPath = '/tmp/my dir/id_rsa';
      (mockExecFile as unknown as jest.Mock).mockImplementation(
        (_file: string, _args: string[], callback: any) => {
          callback(null, { stdout: '', stderr: '' });
          return {} as any;
        }
      );
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      await testGithubAccess(spacedKeyPath);

      expect(mockExecFile).toHaveBeenCalledWith(
        'ssh-add',
        [spacedKeyPath],
        expect.any(Function)
      );
      expect(mockExecFile).toHaveBeenCalledWith(
        'ssh',
        ['-T', 'git@github.com'],
        expect.any(Function)
      );

      consoleSpy.mockRestore();
    });

    it('does not throw when an "ssh -T" spawn failure has no stderr property (regression)', async () => {
      (mockExecFile as unknown as jest.Mock).mockImplementation(
        (file: string, _args: string[], callback: any) => {
          if (file === 'ssh') {
            // A spawn-level failure (e.g. ENOENT, killed by signal) yields
            // an error object with no `stderr` at all.
            callback(new Error('spawn ssh ENOENT'));
          } else {
            callback(null, { stdout: '', stderr: '' });
          }
          return {} as any;
        }
      );
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      await expect(testGithubAccess(mockSshKeyPath)).resolves.toBeUndefined();

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error testing SSH access to GitHub: spawn ssh ENOENT')
      );

      consoleSpy.mockRestore();
    });

    it('treats an "ssh -T" failure containing "successfully authenticated" as success', async () => {
      (mockExecFile as unknown as jest.Mock).mockImplementation(
        (file: string, _args: string[], callback: any) => {
          if (file === 'ssh') {
            const error: any = new Error('Command failed');
            error.stderr = "Hi user! You've successfully authenticated, but GitHub does not provide shell access.";
            callback(error);
          } else {
            callback(null, { stdout: '', stderr: '' });
          }
          return {} as any;
        }
      );
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      await testGithubAccess(mockSshKeyPath);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('successfully authenticated with GitHub')
      );

      consoleSpy.mockRestore();
    });
  });

  describe('copyToClipboard', () => {
    const mockPublicKey = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ test@example.com';

    beforeEach(() => {
      Object.defineProperty(process, 'platform', {
        value: 'darwin',
        writable: true
      });
    });

    it('should copy to clipboard on macOS', async () => {
      const child = createMockChildProcess();
      mockSpawn.mockImplementation((command: any, args: any) => {
        expect(command).toBe('pbcopy');
        expect(args).toEqual([]);
        return child;
      });

      const promise = copyToClipboard(mockPublicKey);
      child.emit('close', 0);
      await promise;

      expect(mockSpawn).toHaveBeenCalledWith('pbcopy', []);
      expect(child.stdin.write).toHaveBeenCalledWith(mockPublicKey);
      expect(child.stdin.end).toHaveBeenCalled();
    });

    it('should copy to clipboard on Windows', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });

      const child = createMockChildProcess();
      mockSpawn.mockImplementation((command: any, args: any) => {
        expect(command).toBe('clip');
        expect(args).toEqual([]);
        return child;
      });

      const promise = copyToClipboard(mockPublicKey);
      child.emit('close', 0);
      await promise;

      expect(mockSpawn).toHaveBeenCalledWith('clip', []);
    });

    it('should copy to clipboard on Linux', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });

      const child = createMockChildProcess();
      mockSpawn.mockImplementation((command: any, args: any) => {
        expect(command).toBe('xclip');
        expect(args).toEqual(['-selection', 'clipboard']);
        return child;
      });

      const promise = copyToClipboard(mockPublicKey);
      child.emit('close', 0);
      await promise;

      expect(mockSpawn).toHaveBeenCalledWith('xclip', ['-selection', 'clipboard']);
    });

    it('should reject on unsupported platform', async () => {
      Object.defineProperty(process, 'platform', { value: 'unsupported' });

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      await expect(copyToClipboard(mockPublicKey)).rejects.toThrow(
        'Unsupported platform for clipboard operations.'
      );

      consoleSpy.mockRestore();
    });

    it('should handle clipboard errors', async () => {
      const child = createMockChildProcess();
      mockSpawn.mockImplementation(() => child);

      const promise = copyToClipboard(mockPublicKey);
      const mockError = new Error('Clipboard not available');
      child.emit('error', mockError);

      await expect(promise).rejects.toThrow(mockError);
    });

    it('should reject when the clipboard process exits with a non-zero code', async () => {
      const child = createMockChildProcess();
      mockSpawn.mockImplementation(() => child);

      const promise = copyToClipboard(mockPublicKey);
      child.emit('close', 1);

      await expect(promise).rejects.toThrow('pbcopy exited with code 1');
    });

    it('rejects (instead of crashing) when the stdin pipe emits an error (regression)', async () => {
      const child = createMockChildProcess();
      mockSpawn.mockImplementation(() => child);

      const promise = copyToClipboard(mockPublicKey);
      const stdinError = new Error('EPIPE: write after end');
      child.stdin.emit('error', stdinError);

      await expect(promise).rejects.toThrow(stdinError);
    });

    it('does not double-settle when both a stdin error and a close event fire', async () => {
      const child = createMockChildProcess();
      mockSpawn.mockImplementation(() => child);

      const promise = copyToClipboard(mockPublicKey);
      const stdinError = new Error('EPIPE: write after end');
      child.stdin.emit('error', stdinError);
      child.emit('close', 0);

      await expect(promise).rejects.toThrow(stdinError);
    });
  });
});
