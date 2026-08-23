import path from 'path';
import os from 'os';

// Mock the home directory for tests
const mockHomeDir = '/mock/home';

beforeEach(() => {
  // Mock os.homedir to return our test directory
  jest.spyOn(os, 'homedir').mockReturnValue(mockHomeDir);
});

afterEach(() => {
  // Restore all mocks after each test
  jest.restoreAllMocks();
});