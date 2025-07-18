import { exec } from 'child_process';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { 
  setGitHubSSHKey, 
  removeSSHKeyFromAgent, 
  testGithubAccess, 
  copyToClipboard 
} from '../../src/utils/index';

jest.mock('child_process');
jest.mock('fs-extra');

const mockExec = exec as jest.MockedFunction<typeof exec>;
const mockFs = fs as jest.Mocked<typeof fs>;

describe('Utility Functions', () => {
  const mockHomeDir = '/mock/home';
  const mockSshKeyPath = '/mock/home/.dss/spaces/test-space/id_rsa';
  const mockSshConfigPath = '/mock/home/.ssh/config';

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(os, 'homedir').mockReturnValue(mockHomeDir);
  });

  describe('setGitHubSSHKey', () => {
    it('should create SSH config for GitHub with new key', async () => {
      mockFs.ensureFile.mockResolvedValue(undefined);
      mockFs.readFile.mockResolvedValue('');
      mockFs.writeFile.mockResolvedValue(undefined);

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

      mockFs.ensureFile.mockResolvedValue(undefined);
      mockFs.readFile.mockResolvedValue(existingConfig);
      mockFs.writeFile.mockResolvedValue(undefined);

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
      mockFs.ensureFile.mockRejectedValue(new Error('Permission denied'));
      
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      await setGitHubSSHKey(mockSshKeyPath);

      expect(consoleSpy).toHaveBeenCalledWith(
        'Failed to update SSH config for GitHub:',
        expect.any(Error)
      );
      
      consoleSpy.mockRestore();
    });
  });

  describe('removeSSHKeyFromAgent', () => {
    it('should remove SSH key from agent successfully', async () => {
      const mockExecAsync = jest.fn().mockResolvedValue({ stdout: '', stderr: '' });
      jest.doMock('util', () => ({
        promisify: () => mockExecAsync
      }));

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      await removeSSHKeyFromAgent(mockSshKeyPath);

      expect(mockExecAsync).toHaveBeenCalledWith(`ssh-add -d ${mockSshKeyPath}`);
      expect(consoleSpy).toHaveBeenCalledWith('SSH key removed from ssh-agent successfully.');
      
      consoleSpy.mockRestore();
    });

    it('should handle errors when removing SSH key', async () => {
      const mockExecAsync = jest.fn().mockRejectedValue(new Error('Key not found'));
      jest.doMock('util', () => ({
        promisify: () => mockExecAsync
      }));

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      await removeSSHKeyFromAgent(mockSshKeyPath);

      expect(consoleSpy).toHaveBeenCalledWith(
        'Error removing SSH key from ssh-agent:',
        'Key not found'
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
      const mockCallback = jest.fn();
      mockExec.mockImplementation((command, callback) => {
        expect(command).toBe(`echo "${mockPublicKey}" | pbcopy`);
        callback!(null, '', '');
        return {} as any;
      });

      await copyToClipboard(mockPublicKey);

      expect(mockExec).toHaveBeenCalledWith(
        `echo "${mockPublicKey}" | pbcopy`,
        expect.any(Function)
      );
    });

    it('should copy to clipboard on Windows', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });

      mockExec.mockImplementation((command, callback) => {
        expect(command).toBe(`echo "${mockPublicKey}" | clip`);
        callback!(null, '', '');
        return {} as any;
      });

      await copyToClipboard(mockPublicKey);

      expect(mockExec).toHaveBeenCalledWith(
        `echo "${mockPublicKey}" | clip`,
        expect.any(Function)
      );
    });

    it('should copy to clipboard on Linux', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });

      mockExec.mockImplementation((command, callback) => {
        expect(command).toBe(`echo "${mockPublicKey}" | xclip -selection clipboard`);
        callback!(null, '', '');
        return {} as any;
      });

      await copyToClipboard(mockPublicKey);

      expect(mockExec).toHaveBeenCalledWith(
        `echo "${mockPublicKey}" | xclip -selection clipboard`,
        expect.any(Function)
      );
    });

    it('should reject on unsupported platform', async () => {
      Object.defineProperty(process, 'platform', { value: 'unsupported' });

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      await expect(copyToClipboard(mockPublicKey)).rejects.toThrow(
        'Unsupported platform for clipboard operations.'
      );

      consoleSpy.mockRestore();
    });

    it('should handle clipboard errors', async () => {
      const mockError = new Error('Clipboard not available');
      mockExec.mockImplementation((command, callback) => {
        callback!(mockError, '', '');
        return {} as any;
      });

      await expect(copyToClipboard(mockPublicKey)).rejects.toThrow(mockError);
    });
  });
});