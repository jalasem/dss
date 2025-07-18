import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { input, confirm, select } from '@inquirer/prompts';
import { 
  addSpace, 
  listSpaces, 
  switchSpace, 
  removeSpace, 
  testSpace 
} from '../../src/utils/SpaceManager';
import { generateSSHKey } from '../../src/utils/sshKeyGen';
import { copyToClipboard, testGithubAccess } from '../../src/utils/index';

jest.mock('fs-extra');
jest.mock('child_process');
jest.mock('@inquirer/prompts');
jest.mock('../../src/utils/sshKeyGen');
jest.mock('../../src/utils/index');

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
    jest.spyOn(os, 'homedir').mockReturnValue(mockHomeDir);
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
  });

  describe('addSpace', () => {
    it('should add a new space successfully', async () => {
      mockFs.ensureFile.mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ spaces: [] });
      mockFs.writeJson.mockResolvedValue(undefined);
      mockFs.readFile.mockResolvedValue(mockPublicKey);
      
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
      mockFs.ensureFile.mockResolvedValue(undefined);
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
      mockFs.ensureFile.mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ spaces: [] });
      mockFs.writeJson.mockResolvedValue(undefined);
      mockFs.readFile.mockResolvedValue(mockPublicKey);
      
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
      mockFs.ensureFile.mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({
        spaces: [
          { name: 'space1', email: 'user1@example.com', userName: 'User1', sshKeyPath: '' },
          { name: 'space2', email: 'user2@example.com', userName: 'User2', sshKeyPath: '' }
        ],
        activeSpace: 'space1'
      });

      await listSpaces();

      expect(console.log).toHaveBeenCalledWith('Your Spaces:');
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('🔥space1'));
    });

    it('should handle no spaces', async () => {
      mockFs.ensureFile.mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ spaces: [] });

      await listSpaces();

      expect(console.log).toHaveBeenCalledWith('⚠️ No spaces have been added yet.');
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
      mockFs.ensureFile.mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ spaces: [mockSpace] });
      mockFs.writeJson.mockResolvedValue(undefined);
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
      mockFs.ensureFile.mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ spaces: [] });

      await switchSpace('nonexistent-space');

      expect(console.log).toHaveBeenCalledWith('Space "nonexistent-space" not found or does not have an associated SSH key. \n');
    });

    it('should handle already active space', async () => {
      mockFs.ensureFile.mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ 
        spaces: [mockSpace], 
        activeSpace: 'test-space' 
      });

      await switchSpace('test-space');

      expect(console.log).toHaveBeenCalledWith('Space "test-space" is already active. \n');
    });

    it('should prompt for space selection when none provided', async () => {
      mockFs.ensureFile.mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ spaces: [mockSpace] });
      mockFs.writeJson.mockResolvedValue(undefined);
      mockSelect.mockResolvedValue('test-space');
      mockConfirm.mockResolvedValue(false);

      await switchSpace();

      expect(mockSelect).toHaveBeenCalledWith({
        message: 'Please choose a space to switch to: ',
        choices: [{ title: 'test-space', value: 'test-space' }]
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
      mockFs.ensureFile.mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ spaces: [mockSpace] });
      mockFs.writeJson.mockResolvedValue(undefined);
      mockSelect.mockResolvedValue('test-space');
      mockConfirm.mockResolvedValue(true);

      await removeSpace();

      expect(mockFs.writeJson).toHaveBeenCalledWith(mockConfigPath, { spaces: [] });
      expect(console.log).toHaveBeenCalledWith("Space 'test-space' has been removed.");
    });

    it('should prevent removing active space', async () => {
      mockFs.ensureFile.mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ 
        spaces: [mockSpace], 
        activeSpace: 'test-space' 
      });
      mockSelect.mockResolvedValue('test-space');

      await removeSpace();

      expect(console.log).toHaveBeenCalledWith(
        "Cannot remove the active space 'test-space'. Please switch to another space first."
      );
    });

    it('should handle removal cancellation', async () => {
      mockFs.ensureFile.mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ spaces: [mockSpace] });
      mockSelect.mockResolvedValue('test-space');
      mockConfirm.mockResolvedValue(false);

      await removeSpace();

      expect(console.log).toHaveBeenCalledWith('Removal cancelled.');
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
      mockFs.ensureFile.mockResolvedValue(undefined);
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
      mockFs.ensureFile.mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ 
        spaces: [spaceWithoutKey], 
        activeSpace: 'test-space' 
      });

      await testSpace();

      expect(console.log).toHaveBeenCalledWith(
        'Active space "test-space" does not have an associated SSH key.'
      );
    });

    it('should handle no spaces', async () => {
      mockFs.ensureFile.mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ spaces: [] });

      await testSpace();

      expect(console.log).toHaveBeenCalledWith('⚠️ No spaces have been added yet.');
    });
  });
});