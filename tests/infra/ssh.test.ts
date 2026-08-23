import { execFile } from 'child_process';
import fs from 'fs-extra';
import os from 'os';
import { confirm } from '@inquirer/prompts';
import {
  setGitHubSSHKey,
  removeSSHKeyFromAgent,
  testGithubAccess,
  addToAgent
} from '../../src/infra/ssh';

jest.mock('child_process');
jest.mock('fs-extra');
jest.mock('@inquirer/prompts', () => ({
  confirm: jest.fn(),
  select: jest.fn(),
  input: jest.fn()
}));

const mockExecFile = execFile as unknown as jest.MockedFunction<typeof execFile>;
const mockFs = fs as jest.Mocked<typeof fs>;
const mockConfirm = confirm as jest.MockedFunction<typeof confirm>;

describe('infra/ssh', () => {
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

  describe('addToAgent', () => {
    const originalPlatform = process.platform;

    function setPlatform(value: NodeJS.Platform): void {
      Object.defineProperty(process, 'platform', { value, configurable: true });
    }

    afterEach(() => {
      setPlatform(originalPlatform);
    });

    it('uses ssh-add --apple-use-keychain on darwin', async () => {
      setPlatform('darwin');
      (mockExecFile as unknown as jest.Mock).mockImplementation(
        (_file: string, _args: string[], callback: any) => {
          callback(null, { stdout: '', stderr: '' });
          return {} as any;
        }
      );

      await addToAgent(mockSshKeyPath);

      expect(mockExecFile).toHaveBeenCalledWith(
        'ssh-add',
        ['--apple-use-keychain', mockSshKeyPath],
        expect.any(Function)
      );
    });

    it('falls back to plain ssh-add on darwin when --apple-use-keychain errors', async () => {
      setPlatform('darwin');
      (mockExecFile as unknown as jest.Mock).mockImplementation(
        (_file: string, args: string[], callback: any) => {
          if (args.includes('--apple-use-keychain')) {
            callback(new Error('unknown option -- apple-use-keychain'));
          } else {
            callback(null, { stdout: '', stderr: '' });
          }
          return {} as any;
        }
      );

      await addToAgent(mockSshKeyPath);

      expect(mockExecFile).toHaveBeenCalledWith(
        'ssh-add',
        ['--apple-use-keychain', mockSshKeyPath],
        expect.any(Function)
      );
      expect(mockExecFile).toHaveBeenCalledWith(
        'ssh-add',
        [mockSshKeyPath],
        expect.any(Function)
      );
    });

    it('uses plain ssh-add on non-darwin platforms (no keychain flag attempted)', async () => {
      setPlatform('linux');
      (mockExecFile as unknown as jest.Mock).mockImplementation(
        (_file: string, _args: string[], callback: any) => {
          callback(null, { stdout: '', stderr: '' });
          return {} as any;
        }
      );

      await addToAgent(mockSshKeyPath);

      expect(mockExecFile).toHaveBeenCalledWith(
        'ssh-add',
        [mockSshKeyPath],
        expect.any(Function)
      );
      expect(mockExecFile).not.toHaveBeenCalledWith(
        'ssh-add',
        expect.arrayContaining(['--apple-use-keychain']),
        expect.any(Function)
      );
    });

    it('propagates an error when the plain ssh-add fallback also fails on darwin', async () => {
      setPlatform('darwin');
      (mockExecFile as unknown as jest.Mock).mockImplementation(
        (_file: string, _args: string[], callback: any) => {
          callback(new Error('ssh-add failed'));
          return {} as any;
        }
      );

      await expect(addToAgent(mockSshKeyPath)).rejects.toThrow('ssh-add failed');
    });

    it('passes an SSH key path containing a space to ssh-add as a single execFile argument (regression)', async () => {
      setPlatform('darwin');
      const spacedKeyPath = '/tmp/my dir/id_rsa';
      (mockExecFile as unknown as jest.Mock).mockImplementation(
        (_file: string, _args: string[], callback: any) => {
          callback(null, { stdout: '', stderr: '' });
          return {} as any;
        }
      );

      await addToAgent(spacedKeyPath);

      expect(mockExecFile).toHaveBeenCalledWith(
        'ssh-add',
        ['--apple-use-keychain', spacedKeyPath],
        expect.any(Function)
      );
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
});
