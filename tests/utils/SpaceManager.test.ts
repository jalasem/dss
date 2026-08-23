import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { input, confirm, select } from '@inquirer/prompts';
import { generateSSHKey } from '../../src/utils/sshKeyGen';
import { copyToClipboard, testGithubAccess } from '../../src/utils/index';
import { UIHelper } from '../../src/utils/ui';

jest.mock('fs-extra');
jest.mock('os');
jest.mock('child_process');
jest.mock('@inquirer/prompts');
jest.mock('../../src/utils/sshKeyGen');
jest.mock('../../src/utils/index');

// Set up os.homedir mock before importing SpaceManager
const mockOs = os as jest.Mocked<typeof os>;
mockOs.homedir.mockReturnValue('/mock/home');

// Now import SpaceManager after mocks are set
const {
  addSpace,
  listSpaces,
  switchSpace,
  removeSpace,
  testSpace,
  modifySpace,
  inspectSpace
} = require('../../src/utils/SpaceManager');

const mockFs = fs as jest.Mocked<typeof fs>;
const mockExecFile = execFile as unknown as jest.MockedFunction<typeof execFile>;
const mockInput = input as jest.MockedFunction<typeof input>;
const mockConfirm = confirm as jest.MockedFunction<typeof confirm>;
const mockSelect = select as jest.MockedFunction<typeof select>;
const mockGenerateSSHKey = generateSSHKey as jest.MockedFunction<typeof generateSSHKey>;
const mockCopyToClipboard = copyToClipboard as jest.MockedFunction<typeof copyToClipboard>;
const mockTestGithubAccess = testGithubAccess as jest.MockedFunction<typeof testGithubAccess>;

// Mirrors @inquirer/core exactly: the class does NOT override `name`,
// so isPromptExitError detection cannot rely on error.name === 'ExitPromptError'.
class ExitPromptError extends Error {}

describe('SpaceManager', () => {
  const mockHomeDir = '/mock/home';
  const mockConfigPath = path.join(mockHomeDir, '.dss', 'spaces', 'config.json');
  const mockSshKeyPath = '/mock/home/.dss/spaces/test-space/id_rsa';
  const mockPublicKey = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ test@example.com';

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
    (mockExecFile as unknown as jest.Mock).mockImplementation(
      (_file: string, _args: string[], callback: any) => {
        callback(null, { stdout: '', stderr: '' });
        return {} as any;
      }
    );
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  describe('addSpace', () => {
    it('should add a new space successfully', async () => {
      (mockFs.ensureFile as jest.Mock).mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ spaces: [] });
      (mockFs.writeJson as jest.Mock).mockResolvedValue(undefined);
      (mockFs.readFile as unknown as jest.Mock).mockResolvedValue(mockPublicKey);
      
      mockInput
        .mockResolvedValueOnce('Test Space')
        .mockResolvedValueOnce('test@example.com')
        .mockResolvedValueOnce('Test User');
      
      mockConfirm
        .mockResolvedValueOnce(true) // Generate SSH key
        .mockResolvedValueOnce(false); // Don't switch to new space

      mockGenerateSSHKey.mockResolvedValue(mockSshKeyPath);
      mockCopyToClipboard.mockResolvedValue('copied');

      await addSpace();

      expect(mockFs.writeJson).toHaveBeenCalledWith(mockConfigPath, {
        spaces: [{
          name: 'test-space',
          email: 'test@example.com',
          userName: 'Test User',
          sshKeyPath: mockSshKeyPath
        }]
      });
    });

    it('should handle duplicate space names', async () => {
      (mockFs.ensureFile as jest.Mock).mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ 
        spaces: [{ name: 'test-space', email: 'existing@example.com', userName: 'Existing', sshKeyPath: '' }] 
      });
      
      mockInput
        .mockResolvedValueOnce('Test Space')
        .mockResolvedValueOnce('test@example.com')
        .mockResolvedValueOnce('Test User');

      await addSpace();

      expect(mockFs.writeJson).not.toHaveBeenCalled();
    });

    it('should handle SSH key generation without switch', async () => {
      (mockFs.ensureFile as jest.Mock).mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ spaces: [] });
      (mockFs.writeJson as jest.Mock).mockResolvedValue(undefined);
      (mockFs.readFile as unknown as jest.Mock).mockResolvedValue(mockPublicKey);
      
      mockInput
        .mockResolvedValueOnce('Test Space')
        .mockResolvedValueOnce('test@example.com')
        .mockResolvedValueOnce('Test User');
      
      mockConfirm
        .mockResolvedValueOnce(true) // Generate SSH key
        .mockResolvedValueOnce(false); // Don't switch to new space

      mockGenerateSSHKey.mockResolvedValue(mockSshKeyPath);
      mockCopyToClipboard.mockResolvedValue('copied');

      await addSpace();

      expect(mockGenerateSSHKey).toHaveBeenCalledWith('test-space', 'test@example.com');
      expect(mockCopyToClipboard).toHaveBeenCalledWith(mockPublicKey);
    });
  });

  describe('listSpaces', () => {
    it('should list spaces with active space indicator', async () => {
      (mockFs.ensureFile as jest.Mock).mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({
        spaces: [
          { name: 'space1', email: 'user1@example.com', userName: 'User1', sshKeyPath: '' },
          { name: 'space2', email: 'user2@example.com', userName: 'User2', sshKeyPath: '' }
        ],
        activeSpace: 'space1'
      });

      await listSpaces();

      // Check that the table was printed - looking for the active space indicator
      const calls = (console.log as jest.Mock).mock.calls.flat();
      const hasActiveSpace = calls.some(call => call && call.includes && call.includes('🔥 space1'));
      expect(hasActiveSpace).toBe(true);
    });

    it('should handle no spaces', async () => {
      (mockFs.ensureFile as jest.Mock).mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ spaces: [] });

      await listSpaces();

      expect(console.log).toHaveBeenCalledTimes(2);
      expect(console.log).toHaveBeenNthCalledWith(1, expect.stringContaining('No spaces have been added yet.'));
      expect(console.log).toHaveBeenNthCalledWith(2, expect.stringContaining('dss add'));
    });
  });

  describe('switchSpace', () => {
    const mockSpace = {
      name: 'test-space',
      email: 'test@example.com',
      userName: 'Test User',
      sshKeyPath: mockSshKeyPath
    };

    it('should switch to a space successfully', async () => {
      (mockFs.ensureFile as jest.Mock).mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ spaces: [mockSpace] });
      (mockFs.writeJson as jest.Mock).mockResolvedValue(undefined);
      mockConfirm.mockResolvedValue(false); // Don't test GitHub access

      await switchSpace('test-space');

      expect(mockExecFile).toHaveBeenCalledWith(
        'git',
        ['config', '--global', 'user.name', mockSpace.userName],
        expect.any(Function)
      );
      expect(mockExecFile).toHaveBeenCalledWith(
        'git',
        ['config', '--global', 'user.email', mockSpace.email],
        expect.any(Function)
      );
      expect(mockExecFile).toHaveBeenCalledWith(
        'ssh-add',
        [mockSpace.sshKeyPath],
        expect.any(Function)
      );
      expect(mockFs.writeJson).toHaveBeenCalledWith(mockConfigPath, {
        spaces: [mockSpace],
        activeSpace: 'test-space'
      });
    });

    it('should handle space not found', async () => {
      (mockFs.ensureFile as jest.Mock).mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ spaces: [] });

      await switchSpace('nonexistent-space');

      expect(console.log).toHaveBeenCalledTimes(2);
      expect(console.log).toHaveBeenNthCalledWith(1, expect.stringContaining('No spaces have been added yet.'));
      expect(console.log).toHaveBeenNthCalledWith(2, expect.stringContaining('dss add'));
    });

    it('should handle already active space', async () => {
      (mockFs.ensureFile as jest.Mock).mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ 
        spaces: [mockSpace], 
        activeSpace: 'test-space' 
      });

      await switchSpace('test-space');

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('is already active'));
    });

    it('should prompt for space selection when none provided', async () => {
      (mockFs.ensureFile as jest.Mock).mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ spaces: [mockSpace] });
      (mockFs.writeJson as jest.Mock).mockResolvedValue(undefined);
      mockSelect.mockResolvedValue('test-space');
      mockConfirm.mockResolvedValue(false);

      await switchSpace();

      expect(mockSelect).toHaveBeenCalledWith({
        message: 'Choose a space to switch to:',
        choices: [{ name: expect.any(String), value: 'test-space', description: 'test@example.com (Test User)' }]
      });
    });

    it('should switch to a keyless space (git config set, no ssh-add, warning printed, activeSpace updated)', async () => {
      const keylessSpace = {
        name: 'keyless-space',
        email: 'keyless@example.com',
        userName: 'Keyless User',
        sshKeyPath: ''
      };
      (mockFs.ensureFile as jest.Mock).mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ spaces: [keylessSpace] });
      (mockFs.writeJson as jest.Mock).mockResolvedValue(undefined);

      await switchSpace('keyless-space');

      expect(mockExecFile).toHaveBeenCalledWith(
        'git',
        ['config', '--global', 'user.name', keylessSpace.userName],
        expect.any(Function)
      );
      expect(mockExecFile).toHaveBeenCalledWith(
        'git',
        ['config', '--global', 'user.email', keylessSpace.email],
        expect.any(Function)
      );
      expect(mockExecFile).not.toHaveBeenCalledWith(
        'ssh-add',
        expect.anything(),
        expect.any(Function)
      );
      expect(mockFs.writeJson).toHaveBeenCalledWith(mockConfigPath, {
        spaces: [keylessSpace],
        activeSpace: 'keyless-space'
      });

      const calls = (console.log as jest.Mock).mock.calls.flat();
      expect(calls.some(call => call && call.includes && call.includes('has no SSH key'))).toBe(true);
    });

    it('should reflect the keyless path in the dry-run preview (no SSH lines)', async () => {
      const keylessSpace = {
        name: 'keyless-space',
        email: 'keyless@example.com',
        userName: 'Keyless User',
        sshKeyPath: ''
      };
      (mockFs.ensureFile as jest.Mock).mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ spaces: [keylessSpace] });

      await switchSpace('keyless-space', { dryRun: true });

      const calls = (console.log as jest.Mock).mock.calls.flat();
      expect(calls.some(call => call && call.includes && call.includes('SSH'))).toBe(false);
      expect(mockFs.writeJson).not.toHaveBeenCalled();
    });

    it('should return null (no throw) when the interactive select is cancelled', async () => {
      (mockFs.ensureFile as jest.Mock).mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ spaces: [mockSpace] });
      mockSelect.mockRejectedValue(new ExitPromptError('User force closed the prompt with 0 null'));

      await expect(switchSpace()).resolves.toBeUndefined();
      expect(mockFs.writeJson).not.toHaveBeenCalled();
    });

    it('should rethrow non-cancellation errors from the interactive select', async () => {
      (mockFs.ensureFile as jest.Mock).mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ spaces: [mockSpace] });
      mockSelect.mockRejectedValue(new Error('boom'));

      await expect(switchSpace()).rejects.toThrow('boom');
    });

    it('should set process.exitCode = 1 when the target space is not found', async () => {
      (mockFs.ensureFile as jest.Mock).mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ spaces: [mockSpace] });

      await switchSpace('does-not-exist');

      expect(process.exitCode).toBe(1);
    });

    it('should find a legacy raw-name space when looked up by its slug', async () => {
      const legacySpace = {
        name: 'Test Space',
        email: 'test@example.com',
        userName: 'Test User',
        sshKeyPath: mockSshKeyPath
      };
      (mockFs.ensureFile as jest.Mock).mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ spaces: [legacySpace] });
      (mockFs.writeJson as jest.Mock).mockResolvedValue(undefined);
      mockConfirm.mockResolvedValue(false);

      await switchSpace('test-space');

      expect(mockFs.writeJson).toHaveBeenCalledWith(mockConfigPath, {
        spaces: [legacySpace],
        activeSpace: 'Test Space'
      });
    });

    it('passes an SSH key path containing a space to ssh-add as a single execFile argument (regression)', async () => {
      const spacedKeyPath = '/tmp/my dir/id_rsa';
      const spacedSpace = {
        name: 'spaced-space',
        email: 'spaced@example.com',
        userName: 'Spaced User',
        sshKeyPath: spacedKeyPath
      };
      (mockFs.ensureFile as jest.Mock).mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ spaces: [spacedSpace] });
      (mockFs.writeJson as jest.Mock).mockResolvedValue(undefined);
      mockConfirm.mockResolvedValue(false);

      await switchSpace('spaced-space');

      expect(mockExecFile).toHaveBeenCalledWith(
        'ssh-add',
        [spacedKeyPath],
        expect.any(Function)
      );
    });
  });

  describe('removeSpace', () => {
    const mockSpace = {
      name: 'test-space',
      email: 'test@example.com',
      userName: 'Test User',
      sshKeyPath: mockSshKeyPath
    };

    it('should remove a space successfully', async () => {
      (mockFs.ensureFile as jest.Mock).mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ spaces: [mockSpace] });
      (mockFs.writeJson as jest.Mock).mockResolvedValue(undefined);
      mockSelect.mockResolvedValue('test-space');
      mockConfirm.mockResolvedValue(true);

      await removeSpace();

      expect(mockFs.writeJson).toHaveBeenCalledWith(mockConfigPath, { spaces: [] });
      const calls = (console.log as jest.Mock).mock.calls.flat();
      const hasRemoveMessage = calls.some(call => 
        call && call.includes && call.includes("has been removed successfully")
      );
      expect(hasRemoveMessage).toBe(true);
    });

    it('should prevent removing active space', async () => {
      (mockFs.ensureFile as jest.Mock).mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ 
        spaces: [mockSpace], 
        activeSpace: 'test-space' 
      });
      mockSelect.mockResolvedValue('test-space');

      await removeSpace();

      // Check for the error message (UIHelper.error uses console.log with red color)
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining("Cannot remove the active space")
      );
    });

    it('should handle removal cancellation', async () => {
      (mockFs.ensureFile as jest.Mock).mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ spaces: [mockSpace] });
      mockSelect.mockResolvedValue('test-space');
      mockConfirm.mockResolvedValue(false);

      await removeSpace();

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Removal cancelled')
      );
      expect(mockFs.writeJson).not.toHaveBeenCalled();
    });

    it('should protect a legacy raw-name active space when looked up by its slug (regression)', async () => {
      // config.activeSpace stores the legacy raw name; the user passes the
      // slug. findSpace resolves them to the same space, and the active-space
      // guard/filter must key off the resolved space's stored name, not the
      // raw input, or the guard is bypassed and nothing is actually removed.
      const legacySpace = {
        name: 'Test Space',
        email: 'test@example.com',
        userName: 'Test User',
        sshKeyPath: mockSshKeyPath
      };
      (mockFs.ensureFile as jest.Mock).mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({
        spaces: [legacySpace],
        activeSpace: 'Test Space'
      });

      await removeSpace('test-space');

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Cannot remove the active space')
      );
      expect(mockFs.writeJson).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });

    it('should find and remove a legacy raw-name space when looked up by its slug', async () => {
      const legacySpace = {
        name: 'Test Space',
        email: 'test@example.com',
        userName: 'Test User',
        sshKeyPath: mockSshKeyPath
      };
      (mockFs.ensureFile as jest.Mock).mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ spaces: [legacySpace] });
      (mockFs.writeJson as jest.Mock).mockResolvedValue(undefined);
      mockConfirm.mockResolvedValue(true);

      await removeSpace('test-space');

      expect(mockFs.writeJson).toHaveBeenCalledWith(mockConfigPath, { spaces: [] });
    });

    it('should set process.exitCode = 1 when the named space is not found', async () => {
      (mockFs.ensureFile as jest.Mock).mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ spaces: [mockSpace] });

      await removeSpace('does-not-exist');

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Space "does-not-exist" not found.'));
      expect(process.exitCode).toBe(1);
    });

    it('should set process.exitCode = 1 when the removal itself fails', async () => {
      (mockFs.ensureFile as jest.Mock).mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ spaces: [mockSpace] });
      mockConfirm.mockResolvedValue(true);
      (mockFs.writeJson as jest.Mock).mockRejectedValue(new Error('disk full'));

      await removeSpace('test-space');

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Failed to remove space'));
      expect(process.exitCode).toBe(1);
    });
  });

  describe('testSpace', () => {
    const mockSpace = {
      name: 'test-space',
      email: 'test@example.com',
      userName: 'Test User',
      sshKeyPath: mockSshKeyPath
    };

    it('should test the active space', async () => {
      (mockFs.ensureFile as jest.Mock).mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ 
        spaces: [mockSpace], 
        activeSpace: 'test-space' 
      });
      mockTestGithubAccess.mockResolvedValue();

      await testSpace();

      expect(mockTestGithubAccess).toHaveBeenCalledWith(mockSshKeyPath);
    });

    it('should handle space without SSH key', async () => {
      const spaceWithoutKey = { ...mockSpace, sshKeyPath: '' };
      (mockFs.ensureFile as jest.Mock).mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ 
        spaces: [spaceWithoutKey], 
        activeSpace: 'test-space' 
      });

      await testSpace();

      expect(console.log).toHaveBeenCalledTimes(2);
      expect(console.log).toHaveBeenNthCalledWith(1, expect.stringContaining('Active space "test-space" does not have an associated SSH key.'));
      expect(console.log).toHaveBeenNthCalledWith(2, expect.stringContaining('dss edit test-space'));
    });

    it('should handle no spaces', async () => {
      (mockFs.ensureFile as jest.Mock).mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ spaces: [] });

      await testSpace();

      expect(console.log).toHaveBeenCalledTimes(2);
      expect(console.log).toHaveBeenNthCalledWith(1, expect.stringContaining('No spaces have been added yet.'));
      expect(console.log).toHaveBeenNthCalledWith(2, expect.stringContaining('dss add'));
    });

    it('should target the named space rather than the active one', async () => {
      const otherSpace = {
        name: 'other-space',
        email: 'other@example.com',
        userName: 'Other User',
        sshKeyPath: '/mock/home/.dss/spaces/other-space/id_rsa'
      };
      (mockFs.ensureFile as jest.Mock).mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({
        spaces: [mockSpace, otherSpace],
        activeSpace: 'test-space'
      });
      mockTestGithubAccess.mockResolvedValue();

      await testSpace('other-space');

      expect(mockTestGithubAccess).toHaveBeenCalledWith(otherSpace.sshKeyPath);
    });

    it('should NOT fall back to the active space when a named space does not exist', async () => {
      (mockFs.ensureFile as jest.Mock).mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({
        spaces: [mockSpace],
        activeSpace: 'test-space'
      });

      await testSpace('does-not-exist');

      expect(mockTestGithubAccess).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Space "does-not-exist" not found.'));
      expect(process.exitCode).toBe(1);
    });

    it('should find a legacy raw-name space when looked up by its slug', async () => {
      const legacySpace = {
        name: 'Test Space',
        email: 'test@example.com',
        userName: 'Test User',
        sshKeyPath: mockSshKeyPath
      };
      (mockFs.ensureFile as jest.Mock).mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ spaces: [legacySpace], activeSpace: 'Test Space' });
      mockTestGithubAccess.mockResolvedValue();

      await testSpace('test-space');

      expect(mockTestGithubAccess).toHaveBeenCalledWith(mockSshKeyPath);
    });
  });

  describe('modifySpace', () => {
    const mockSpace = {
      name: 'test-space',
      email: 'test@example.com',
      userName: 'Test User',
      sshKeyPath: mockSshKeyPath
    };

    it('should skip the select prompt when a space name is provided', async () => {
      (mockFs.ensureFile as jest.Mock).mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ spaces: [mockSpace] });
      (mockFs.writeJson as jest.Mock).mockResolvedValue(undefined);

      mockInput
        .mockResolvedValueOnce(mockSpace.name)
        .mockResolvedValueOnce(mockSpace.email)
        .mockResolvedValueOnce(mockSpace.userName);

      await modifySpace('test-space');

      expect(mockSelect).not.toHaveBeenCalled();
    });

    it('should error when the named space does not exist', async () => {
      (mockFs.ensureFile as jest.Mock).mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ spaces: [mockSpace] });

      await modifySpace('nonexistent-space');

      expect(mockSelect).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Space "nonexistent-space" not found.'));
    });

    it('should still prompt for selection when no name is provided', async () => {
      (mockFs.ensureFile as jest.Mock).mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ spaces: [mockSpace] });
      (mockFs.writeJson as jest.Mock).mockResolvedValue(undefined);
      mockSelect.mockResolvedValue('test-space');

      mockInput
        .mockResolvedValueOnce(mockSpace.name)
        .mockResolvedValueOnce(mockSpace.email)
        .mockResolvedValueOnce(mockSpace.userName);

      await modifySpace();

      expect(mockSelect).toHaveBeenCalled();
    });

    it('should move the key directory, update sshKeyPath and activeSpace on rename of the active space', async () => {
      const spaceToRename = {
        name: 'test-space',
        email: 'test@example.com',
        userName: 'Test User',
        sshKeyPath: mockSshKeyPath
      };
      (mockFs.ensureFile as jest.Mock).mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ spaces: [spaceToRename], activeSpace: 'test-space' });
      (mockFs.writeJson as jest.Mock).mockResolvedValue(undefined);
      (mockFs.pathExists as unknown as jest.Mock).mockResolvedValue(true);
      (mockFs.move as unknown as jest.Mock).mockResolvedValue(undefined);

      mockInput
        .mockResolvedValueOnce('New Name') // new name
        .mockResolvedValueOnce(spaceToRename.email) // email unchanged
        .mockResolvedValueOnce(spaceToRename.userName); // userName unchanged

      await modifySpace('test-space');

      const oldKeyDir = path.dirname(mockSshKeyPath);
      const newKeyDir = path.join(path.dirname(oldKeyDir), 'new-name');
      const newSshKeyPath = path.join(newKeyDir, path.basename(mockSshKeyPath));

      expect(mockFs.move).toHaveBeenCalledWith(oldKeyDir, newKeyDir);
      expect(mockFs.writeJson).toHaveBeenCalledWith(mockConfigPath, {
        spaces: [{
          name: 'new-name',
          email: mockSpace.email,
          userName: mockSpace.userName,
          sshKeyPath: newSshKeyPath
        }],
        activeSpace: 'new-name'
      });
    });

    it('should not move the key directory when renaming an inactive, keyless space', async () => {
      // NOTE: built from independent literals (not spread from the shared
      // `mockSpace`) because modifySpace mutates space objects in place and
      // an earlier test in this block renames the shared fixture.
      const keylessSpace = {
        name: 'test-space',
        email: 'test@example.com',
        userName: 'Test User',
        sshKeyPath: ''
      };
      (mockFs.ensureFile as jest.Mock).mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ spaces: [keylessSpace], activeSpace: 'other-active' });
      (mockFs.writeJson as jest.Mock).mockResolvedValue(undefined);

      mockInput
        .mockResolvedValueOnce('New Name')
        .mockResolvedValueOnce(keylessSpace.email)
        .mockResolvedValueOnce(keylessSpace.userName);

      await modifySpace('test-space');

      expect(mockFs.move).not.toHaveBeenCalled();
      expect(mockFs.writeJson).toHaveBeenCalledWith(mockConfigPath, {
        spaces: [{ ...keylessSpace, name: 'new-name' }],
        activeSpace: 'other-active'
      });
    });

    it('should re-apply global git config when the active space email/userName change', async () => {
      const activeSpace = {
        name: 'test-space',
        email: 'test@example.com',
        userName: 'Test User',
        sshKeyPath: mockSshKeyPath
      };
      (mockFs.ensureFile as jest.Mock).mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ spaces: [activeSpace], activeSpace: 'test-space' });
      (mockFs.writeJson as jest.Mock).mockResolvedValue(undefined);

      mockInput
        .mockResolvedValueOnce(activeSpace.name) // name unchanged
        .mockResolvedValueOnce('new-email@example.com')
        .mockResolvedValueOnce('New User Name');

      await modifySpace('test-space');

      expect(mockExecFile).toHaveBeenCalledWith(
        'git',
        ['config', '--global', 'user.name', 'New User Name'],
        expect.any(Function)
      );
      expect(mockExecFile).toHaveBeenCalledWith(
        'git',
        ['config', '--global', 'user.email', 'new-email@example.com'],
        expect.any(Function)
      );
    });

    it('should persist config before re-applying git, then report failure (exit 1) if the git re-apply fails, without losing the saved changes', async () => {
      const activeSpace = {
        name: 'test-space',
        email: 'test@example.com',
        userName: 'Test User',
        sshKeyPath: mockSshKeyPath
      };
      (mockFs.ensureFile as jest.Mock).mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ spaces: [activeSpace], activeSpace: 'test-space' });
      (mockFs.writeJson as jest.Mock).mockResolvedValue(undefined);
      (mockExecFile as unknown as jest.Mock).mockImplementation(
        (_file: string, _args: string[], callback: any) => {
          callback(new Error('git not found'));
          return {} as any;
        }
      );

      mockInput
        .mockResolvedValueOnce(activeSpace.name)
        .mockResolvedValueOnce('new-email@example.com')
        .mockResolvedValueOnce(activeSpace.userName);

      await modifySpace('test-space');

      // Config is persisted with the new email BEFORE the git re-apply runs,
      // so disk state isn't left inconsistent when the re-apply fails.
      expect(mockFs.writeJson).toHaveBeenCalledWith(mockConfigPath, {
        spaces: [{ ...activeSpace, email: 'new-email@example.com' }],
        activeSpace: 'test-space'
      });
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Failed to update global git configuration'));
      expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('updated successfully'));
      expect(process.exitCode).toBe(1);
    });

    it('should move the key dir and persist config before a rename+active-space git re-apply failure', async () => {
      const activeSpace = {
        name: 'test-space',
        email: 'test@example.com',
        userName: 'Test User',
        sshKeyPath: mockSshKeyPath
      };
      (mockFs.ensureFile as jest.Mock).mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ spaces: [activeSpace], activeSpace: 'test-space' });
      (mockFs.writeJson as jest.Mock).mockResolvedValue(undefined);
      (mockFs.pathExists as unknown as jest.Mock).mockResolvedValue(true);
      (mockFs.move as unknown as jest.Mock).mockResolvedValue(undefined);
      (mockExecFile as unknown as jest.Mock).mockImplementation(
        (_file: string, _args: string[], callback: any) => {
          callback(new Error('git not found'));
          return {} as any;
        }
      );

      mockInput
        .mockResolvedValueOnce('New Name') // rename
        .mockResolvedValueOnce('new-email@example.com') // + email change (active -> triggers git re-apply)
        .mockResolvedValueOnce(activeSpace.userName);

      await modifySpace('test-space');

      const oldKeyDir = path.dirname(mockSshKeyPath);
      const newKeyDir = path.join(path.dirname(oldKeyDir), 'new-name');
      const newSshKeyPath = path.join(newKeyDir, path.basename(mockSshKeyPath));

      // The key directory move and the config write (reflecting the rename,
      // moved sshKeyPath, and new activeSpace) both happened before the git
      // re-apply failed, so nothing is orphaned.
      expect(mockFs.move).toHaveBeenCalledWith(oldKeyDir, newKeyDir);
      expect(mockFs.writeJson).toHaveBeenCalledWith(mockConfigPath, {
        spaces: [{
          name: 'new-name',
          email: 'new-email@example.com',
          userName: activeSpace.userName,
          sshKeyPath: newSshKeyPath
        }],
        activeSpace: 'new-name'
      });
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Failed to update global git configuration'));
      expect(process.exitCode).toBe(1);
    });

    it('should call fail() (not throw) when moving the key directory fails', async () => {
      const activeSpace = {
        name: 'test-space',
        email: 'test@example.com',
        userName: 'Test User',
        sshKeyPath: mockSshKeyPath
      };
      (mockFs.ensureFile as jest.Mock).mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ spaces: [activeSpace], activeSpace: 'test-space' });
      (mockFs.pathExists as unknown as jest.Mock).mockResolvedValue(true);
      (mockFs.move as unknown as jest.Mock).mockRejectedValue(new Error('EACCES: permission denied'));

      mockInput
        .mockResolvedValueOnce('New Name')
        .mockResolvedValueOnce(activeSpace.email)
        .mockResolvedValueOnce(activeSpace.userName);

      await expect(modifySpace('test-space')).resolves.toBeUndefined();

      expect(mockFs.writeJson).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Failed to move key directory'));
      expect(process.exitCode).toBe(1);
    });

    it('should reject a rename that collides with another space (slug dedupe)', async () => {
      const spaceToRename = {
        name: 'test-space',
        email: 'test@example.com',
        userName: 'Test User',
        sshKeyPath: mockSshKeyPath
      };
      const otherSpace = {
        name: 'other-space',
        email: 'other@example.com',
        userName: 'Other',
        sshKeyPath: '/mock/home/.dss/spaces/other-space/id_rsa'
      };
      (mockFs.ensureFile as jest.Mock).mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ spaces: [spaceToRename, otherSpace] });

      mockInput
        .mockResolvedValueOnce('Other Space') // slugifies to "other-space", collides
        .mockResolvedValueOnce(spaceToRename.email)
        .mockResolvedValueOnce(spaceToRename.userName);

      await modifySpace('test-space');

      expect(mockFs.move).not.toHaveBeenCalled();
      expect(mockFs.writeJson).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Another space with the name "Other Space" already exists.'));
      expect(process.exitCode).toBe(1);
    });
  });

  describe('inspectSpace', () => {
    const mockSpace = {
      name: 'test-space',
      email: 'test@example.com',
      userName: 'Test User',
      sshKeyPath: mockSshKeyPath
    };

    beforeEach(() => {
      mockOs.homedir.mockReturnValue('/mock/home');
      (mockFs.ensureFile as jest.Mock).mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ spaces: [mockSpace], activeSpace: 'test-space' });
      (mockFs.pathExists as unknown as jest.Mock).mockResolvedValue(true);
      (mockFs.readFile as unknown as jest.Mock).mockResolvedValue('Host github.com\n  IdentityFile ' + mockSshKeyPath);
      (mockFs.stat as unknown as jest.Mock).mockResolvedValue({ mode: 0o100600 });
      (mockFs.readdir as unknown as jest.Mock).mockResolvedValue(['id_rsa', 'id_rsa.pub']);
      (mockExecFile as unknown as jest.Mock).mockImplementation(
        (_file: string, _args: string[], callback: any) => {
          callback(null, { stdout: 'Test User', stderr: '' });
          return {} as any;
        }
      );
    });

    it('reports "Key loaded" when the fingerprint is present in ssh-add -l output', async () => {
      (mockExecFile as unknown as jest.Mock).mockImplementation((file: string, _args: string[], cb: any) => {
        if (file === 'ssh-keygen') {
          cb(null, { stdout: '2048 SHA256:abc123DEF comment (RSA)\n', stderr: '' });
        } else if (file === 'ssh-add') {
          cb(null, { stdout: '2048 SHA256:abc123DEF comment (RSA)\n', stderr: '' });
        } else {
          cb(null, { stdout: 'Test User', stderr: '' });
        }
      });

      const printStatusSpy = jest.spyOn(UIHelper, 'printStatus');

      await inspectSpace('test-space');

      const agentCall = printStatusSpy.mock.calls.find(call => call[0] === 'SSH Agent');
      expect(agentCall?.[1]).toBe('Key loaded');
      printStatusSpy.mockRestore();
    });

    it('reports "Key not loaded" when the fingerprint is absent from ssh-add -l output', async () => {
      (mockExecFile as unknown as jest.Mock).mockImplementation((file: string, _args: string[], cb: any) => {
        if (file === 'ssh-keygen') {
          cb(null, { stdout: '2048 SHA256:abc123DEF comment (RSA)\n', stderr: '' });
        } else if (file === 'ssh-add') {
          cb(null, { stdout: '2048 SHA256:zzz999OTHER comment (RSA)\n', stderr: '' });
        } else {
          cb(null, { stdout: 'Test User', stderr: '' });
        }
      });

      const printStatusSpy = jest.spyOn(UIHelper, 'printStatus');

      await inspectSpace('test-space');

      const agentCall = printStatusSpy.mock.calls.find(call => call[0] === 'SSH Agent');
      expect(agentCall?.[1]).toBe('Key not loaded');
      printStatusSpy.mockRestore();
    });

    it('reports "Unable to check" when the fingerprint or agent command fails', async () => {
      (mockExecFile as unknown as jest.Mock).mockImplementation((_file: string, _args: string[], cb: any) =>
        cb(new Error('ssh-keygen failed'))
      );

      const printStatusSpy = jest.spyOn(UIHelper, 'printStatus');

      await inspectSpace('test-space');

      const agentCall = printStatusSpy.mock.calls.find(call => call[0] === 'SSH Agent');
      expect(agentCall?.[1]).toBe('Unable to check');
      printStatusSpy.mockRestore();
    });

    it('should set process.exitCode = 1 when the named space is not found', async () => {
      await inspectSpace('does-not-exist');

      expect(process.exitCode).toBe(1);
    });
  });
});