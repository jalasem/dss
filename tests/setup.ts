import path from 'path';
import os from 'os';

// Mock the home directory for tests
const mockHomeDir = '/mock/home';

beforeEach(() => {
  // Mock os.homedir to return our test directory
  jest.spyOn(os, 'homedir').mockReturnValue(mockHomeDir);

  // Jest's stdin isn't a TTY, which would otherwise make isNonInteractive()
  // (src/commands/prompts.ts) true by default and break every existing
  // prompt-mocking test. Default to "interactive" here — mirrors ui.test.ts
  // flipping stdout.isTTY to exercise its non-default branch — and let the
  // handful of tests that specifically exercise non-interactive/guarded
  // behavior flip this back (and restore it) themselves.
  (process.stdin as any).isTTY = true;
  delete process.env.DSS_NO_INPUT;
});

afterEach(() => {
  // Restore all mocks after each test
  jest.restoreAllMocks();
});