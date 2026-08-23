import { confirm } from '@inquirer/prompts';
import { testGithubAccess } from '../../src/utils';
import { generateCompletionScript } from '../../src/utils/completion';
import { bindSpaceToRepository } from '../../src/utils/repoBindingCommands';
import { safeConfirm, isPromptExitError } from '../../src/utils/prompts';
import { UIHelper } from '../../src/utils/ui';
import { execFile } from 'child_process';
import fs from 'fs-extra';

jest.mock('@inquirer/prompts', () => ({
  confirm: jest.fn(),
  select: jest.fn(),
  input: jest.fn()
}));
jest.mock('child_process');
jest.mock('fs-extra');
jest.mock('../../src/utils/repoBinding', () => ({
  bindRepositories: jest.fn(),
  bindRepository: jest.fn(),
  discoverRepositories: jest.fn(),
  getRepositoryBindingStatus: jest.fn(),
  unbindRepository: jest.fn()
}));

const mockConfirm = confirm as jest.MockedFunction<typeof confirm>;
const mockExecFile = execFile as unknown as jest.MockedFunction<typeof execFile>;
const mockFs = fs as jest.Mocked<typeof fs>;

// Mirrors @inquirer/core exactly: the class does NOT override `name`,
// so detection cannot rely on error.name === 'ExitPromptError'.
class ExitPromptError extends Error {}

function createExitPromptError(): Error {
  return new ExitPromptError('User force closed the prompt with 0 null');
}

describe('prompt cancellation handling', () => {
  let errorSpy: jest.SpyInstance;
  let infoSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    process.exitCode = undefined;
    errorSpy = jest.spyOn(UIHelper, 'error').mockImplementation(() => {});
    infoSpy = jest.spyOn(UIHelper, 'info').mockImplementation(() => {});
    jest.spyOn(UIHelper, 'success').mockImplementation(() => {});
    jest.spyOn(UIHelper, 'printHeader').mockImplementation(() => {});
    jest.spyOn(UIHelper, 'printInfoBox').mockImplementation(() => {});
    jest.spyOn(UIHelper, 'printStatus').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.exitCode = undefined;
  });

  describe('safeConfirm', () => {
    it('returns the answer when the prompt completes', async () => {
      mockConfirm.mockResolvedValue(true as never);
      await expect(safeConfirm({ message: 'ok?' })).resolves.toBe(true);
    });

    it('returns false when the prompt is closed without an answer', async () => {
      mockConfirm.mockRejectedValue(createExitPromptError());
      await expect(safeConfirm({ message: 'ok?', default: true })).resolves.toBe(false);
    });

    it('rethrows unrelated errors', async () => {
      mockConfirm.mockRejectedValue(new Error('boom'));
      await expect(safeConfirm({ message: 'ok?' })).rejects.toThrow('boom');
    });
  });

  describe('isPromptExitError', () => {
    it('recognizes a real ExitPromptError (class name only, no name override)', () => {
      expect(isPromptExitError(createExitPromptError())).toBe(true);
      expect(isPromptExitError(new Error('other'))).toBe(false);
      expect(isPromptExitError('string')).toBe(false);
    });

    it('recognizes future versions that set error.name explicitly', () => {
      const named = new Error('closed');
      named.name = 'ExitPromptError';
      expect(isPromptExitError(named)).toBe(true);
    });
  });

  describe('dss test (testGithubAccess)', () => {
    it('does not report an SSH error when the public-key prompt is closed', async () => {
      (mockExecFile as unknown as jest.Mock).mockImplementation(
        (_file: string, _args: string[], callback: (error: Error | null, result: { stdout: string; stderr: string }) => void) => {
          callback(null, { stdout: '', stderr: '' });
        }
      );
      mockConfirm.mockRejectedValue(createExitPromptError());

      await testGithubAccess('/mock/key');

      expect(errorSpy).not.toHaveBeenCalled();
    });
  });

  describe('dss completion', () => {
    it('resolves without throwing and skips saving when the prompt is closed', async () => {
      mockConfirm.mockRejectedValue(createExitPromptError());
      const writeFile = mockFs.writeFile as unknown as jest.Mock;
      writeFile.mockResolvedValue(undefined);

      await expect(generateCompletionScript('zsh')).resolves.toBeUndefined();

      expect(writeFile).not.toHaveBeenCalled();
    });
  });

  describe('dss bind', () => {
    it('cancels cleanly when the recursive confirmation prompt is closed', async () => {
      const { discoverRepositories, bindRepositories } = jest.requireMock('../../src/utils/repoBinding');
      (mockFs.pathExists as unknown as jest.Mock).mockResolvedValue(true);
      (mockFs.readJson as unknown as jest.Mock).mockResolvedValue({
        spaces: [{ name: 'Work', email: 'w@x.com', userName: 'W', sshKeyPath: '/mock/key' }]
      });
      discoverRepositories.mockResolvedValue(['/repo/a', '/repo/b']);
      mockConfirm.mockRejectedValue(createExitPromptError());

      await bindSpaceToRepository('Work', { recursive: '/repos' });

      expect(bindRepositories).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
      expect(infoSpy).toHaveBeenCalledWith('Repository binding cancelled.');
    });
  });
});
