import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { generateSSHKey } from '../../src/utils/sshKeyGen';

jest.mock('fs-extra');
jest.mock('ssh-keygen', () => jest.fn());
jest.mock('../../src/utils/ui');

const mockFs = fs as jest.Mocked<typeof fs>;
const mockKeygen = require('ssh-keygen') as jest.MockedFunction<any>;

describe('SSH Key Generation', () => {
  const mockHomeDir = '/mock/home';
  const spaceName = 'test-space';
  const email = 'test@example.com';
  const expectedKeyPath = path.join(mockHomeDir, '.dss', 'spaces', spaceName, 'id_rsa');

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(os, 'homedir').mockReturnValue(mockHomeDir);
    (mockFs.ensureDir as jest.Mock).mockResolvedValue(undefined);
  });

  it('should generate SSH key successfully', async () => {
    mockKeygen.mockImplementation((options: any, callback: any) => {
      expect(options).toEqual({
        location: expectedKeyPath,
        comment: email,
        password: '',
        read: true
      });
      callback(null);
    });

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

    const result = await generateSSHKey(spaceName, email);

    expect(mockFs.ensureDir).toHaveBeenCalledWith(
      path.join(mockHomeDir, '.dss', 'spaces', spaceName)
    );
    expect(result).toBe(expectedKeyPath);
    expect(consoleSpy).toHaveBeenCalledWith('Generated SSH key at:', expectedKeyPath);
    
    consoleSpy.mockRestore();
  });

  it('should handle SSH key generation errors', async () => {
    const mockError = new Error('SSH key generation failed');
    mockKeygen.mockImplementation((options: any, callback: any) => {
      callback(mockError);
    });

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

    await expect(generateSSHKey(spaceName, email)).rejects.toThrow(mockError);

    expect(consoleSpy).toHaveBeenCalledWith('SSH key generation failed:', mockError);
    
    consoleSpy.mockRestore();
  });

  it('should create proper directory structure', async () => {
    mockKeygen.mockImplementation((options: any, callback: any) => {
      callback(null);
    });

    await generateSSHKey(spaceName, email);

    expect(mockFs.ensureDir).toHaveBeenCalledWith(
      path.join(mockHomeDir, '.dss', 'spaces', spaceName)
    );
  });

  it('should handle special characters in space name', async () => {
    const specialSpaceName = 'test space-with_special.chars';
    const expectedPath = path.join(mockHomeDir, '.dss', 'spaces', specialSpaceName, 'id_rsa');

    mockKeygen.mockImplementation((options: any, callback: any) => {
      expect(options.location).toBe(expectedPath);
      callback(null);
    });

    const result = await generateSSHKey(specialSpaceName, email);

    expect(result).toBe(expectedPath);
  });
});