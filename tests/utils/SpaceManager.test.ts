import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { input, confirm, select } from '@inquirer/prompts';
import { generateSSHKey } from '../../src/utils/sshKeyGen';
import { copyToClipboard, testGithubAccess } from '../../src/utils/index';

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
  testSpace 
} = require('../../src/utils/SpaceManager');

const mockFs = fs as jest.Mocked<typeof fs>;
const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;
const mockInput = input as jest.MockedFunction<typeof input>;
const mockConfirm = confirm as jest.MockedFunction<typeof confirm>;
const mockSelect = select as jest.MockedFunction<typeof select>;
const mockGenerateSSHKey = generateSSHKey as jest.MockedFunction<typeof generateSSHKey>;
const mockCopyToClipboard = copyToClipboard as jest.MockedFunction<typeof copyToClipboard>;
const mockTestGithubAccess = testGithubAccess as jest.MockedFunction<typeof testGithubAccess>;

describe('SpaceManager', () => {
  const mockHomeDir = '/mock/home';
  const mockConfigPath = path.join(mockHomeDir, '.dss', 'spaces', 'config.json');
  const mockSshKeyPath = '/mock/home/.dss/spaces/test-space/id_rsa';
  const mockPublicKey = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ test@example.com';

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
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
          name: 'Test Space',
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

      expect(mockExecSync).toHaveBeenCalledWith(`git config --global user.name "${mockSpace.userName}"`);
      expect(mockExecSync).toHaveBeenCalledWith(`git config --global user.email "${mockSpace.email}"`);
      expect(mockExecSync).toHaveBeenCalledWith(`ssh-add ${mockSpace.sshKeyPath}`);
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
  });
});