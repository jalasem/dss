import fs from 'fs-extra';
import path from 'path';
import os from 'os';

// Mock the home directory for tests
const mockHomeDir = path.join(__dirname, '__mocks__', 'home');

beforeEach(async () => {
  // Ensure mock home directory exists
  await fs.ensureDir(mockHomeDir);
  
  // Mock os.homedir to return our test directory
  jest.spyOn(os, 'homedir').mockReturnValue(mockHomeDir);
});

afterEach(async () => {
  // Clean up mock directories after each test
  await fs.remove(mockHomeDir);
  jest.restoreAllMocks();
});