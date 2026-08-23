import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { input, confirm, select, password } from '@inquirer/prompts';
import { generateKey } from '../../src/infra/keys';
import { copyToClipboard } from '../../src/infra/clipboard';
import { testHostAccess, removeSSHKeyFromAgent, addToAgent, setHostSSHKey } from '../../src/infra/ssh';
import { writeActiveGitconfig, ensureGlobalInclude } from '../../src/infra/git';
import { bindRepository } from '../../src/infra/repoBinding';
import { UIHelper } from '../../src/commands/ui';
import type { loadStore as LoadStore, saveStore as SaveStore, fromSpace as FromSpace, IStoreV2 } from '../../src/infra/store';
import type { ISpace, IKeyInfo } from '../../src/core/types';

jest.mock('fs-extra');
jest.mock('os');
jest.mock('child_process');
jest.mock('@inquirer/prompts');
jest.mock('../../src/infra/keys');
jest.mock('../../src/infra/clipboard');
jest.mock('../../src/infra/ssh');
jest.mock('../../src/infra/repoBinding');
jest.mock('../../src/infra/git', () => {
  // getGitUser (used by inspectSpace) keeps its real implementation, which
  // reads through the mocked child_process execFile — only the includeIf-
  // first write path is replaced with controllable jest.fn()s.
  const actual = jest.requireActual('../../src/infra/git');
  return {
    ...actual,
    writeActiveGitconfig: jest.fn(),
    ensureGlobalInclude: jest.fn()
  };
});
jest.mock('../../src/infra/store', () => {
  const actual = jest.requireActual('../../src/infra/store');
  const loadStore = jest.fn();
  const saveStore = jest.fn();
  // loadConfig/persistConfig are defined in the real module in terms of a
  // same-file reference to loadStore/saveStore, which a jest.mock property
  // override can't intercept (the real functions still call the real
  // loadStore/saveStore internally). Rebuild them here on top of the mocks
  // so tests can drive loadStore/saveStore and still exercise the real
  // toSpace/mergeIdentity view-mapping logic.
  return {
    ...actual,
    loadStore,
    saveStore,
    loadConfig: async () => {
      const store = await loadStore();
      const originalBySpace = new Map();
      const spaces = store.identities.map((identity: any) => {
        const space = actual.toSpace(identity);
        originalBySpace.set(space, identity);
        return space;
      });
      return { store, config: { spaces, activeSpace: store.active }, originalBySpace };
    },
    persistConfig: async (store: any, config: any, originalBySpace: Map<any, any>) => {
      store.identities = config.spaces.map((space: any) => actual.mergeIdentity(space, originalBySpace.get(space)));
      store.active = config.activeSpace;
      await saveStore(store);
    }
  };
});

// Set up os.homedir mock before importing spaces (and the store module,
// whose config path constant is computed once, at require time).
const mockOs = os as jest.Mocked<typeof os>;
mockOs.homedir.mockReturnValue('/mock/home');

// Now import the spaces commands (and the store) after mocks are set
const {
  addSpace,
  listSpaces,
  switchSpace,
  removeSpace,
  testSpace,
  modifySpace,
  inspectSpace
} = require('../../src/commands/spaces');
const { loadStore, saveStore, fromSpace } = require('../../src/infra/store');

const mockFs = fs as jest.Mocked<typeof fs>;
const mockExecFile = execFile as unknown as jest.MockedFunction<typeof execFile>;
const mockInput = input as jest.MockedFunction<typeof input>;
const mockConfirm = confirm as jest.MockedFunction<typeof confirm>;
const mockSelect = select as jest.MockedFunction<typeof select>;
const mockPassword = password as jest.MockedFunction<typeof password>;
const mockGenerateKey = generateKey as jest.MockedFunction<typeof generateKey>;
const mockCopyToClipboard = copyToClipboard as jest.MockedFunction<typeof copyToClipboard>;
const mockTestHostAccess = testHostAccess as jest.MockedFunction<typeof testHostAccess>;
const mockRemoveSSHKeyFromAgent = removeSSHKeyFromAgent as jest.MockedFunction<typeof removeSSHKeyFromAgent>;
const mockAddToAgent = addToAgent as jest.MockedFunction<typeof addToAgent>;
const mockSetHostSSHKey = setHostSSHKey as jest.MockedFunction<typeof setHostSSHKey>;
const mockWriteActiveGitconfig = writeActiveGitconfig as jest.MockedFunction<typeof writeActiveGitconfig>;
const mockEnsureGlobalInclude = ensureGlobalInclude as jest.MockedFunction<typeof ensureGlobalInclude>;
const mockBindRepository = bindRepository as jest.MockedFunction<typeof bindRepository>;
const mockLoadStore = loadStore as jest.MockedFunction<typeof LoadStore>;
const mockSaveStore = saveStore as jest.MockedFunction<typeof SaveStore>;
const typedFromSpace = fromSpace as typeof FromSpace;

function storeOf(spaces: ISpace[], active?: string): IStoreV2 {
  return { version: 2, identities: spaces.map(typedFromSpace), active, bindings: [] };
}

// Mirrors @inquirer/core exactly: the class does NOT override `name`,
// so isPromptExitError detection cannot rely on error.name === 'ExitPromptError'.
class ExitPromptError extends Error {}

describe('commands/spaces', () => {
  const mockHomeDir = '/mock/home';
  const mockConfigPath = path.join(mockHomeDir, '.dss', 'spaces', 'config.json');
  const mockSshKeyPath = '/mock/home/.dss/spaces/test-space/id_rsa';
  const mockPublicKey = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ test@example.com';

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
    // resetMocks (jest.config.js) wipes mock implementations before every
    // test, including this file-scope os.homedir() set at require-time —
    // re-apply it here since some flows (e.g. addSpace's key directory
    // construction) call os.homedir() at runtime, not just at import time.
    mockOs.homedir.mockReturnValue(mockHomeDir);
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
    const mockKeyInfo: IKeyInfo = {
      path: mockSshKeyPath,
      algorithm: 'ed25519',
      createdAt: '2024-01-01T00:00:00.000Z',
      fingerprint: 'SHA256:abc123'
    };

    it('should add a new space successfully, persisting full key metadata (fingerprint/createdAt)', async () => {
      mockLoadStore.mockResolvedValue(storeOf([]));
      (mockFs.readFile as unknown as jest.Mock).mockResolvedValue(mockPublicKey);

      mockInput
        .mockResolvedValueOnce('Test Space')
        .mockResolvedValueOnce('test@example.com')
        .mockResolvedValueOnce('Test User');

      mockConfirm
        .mockResolvedValueOnce(true) // Generate SSH key
        .mockResolvedValueOnce(false); // Don't switch to new space

      mockPassword.mockResolvedValueOnce('');
      mockGenerateKey.mockResolvedValue(mockKeyInfo);
      mockCopyToClipboard.mockResolvedValue('copied');

      await addSpace();

      expect(mockSaveStore).toHaveBeenLastCalledWith({
        version: 2,
        identities: [{
          name: 'test-space',
          email: 'test@example.com',
          userName: 'Test User',
          host: 'github.com',
          key: mockKeyInfo
        }],
        active: undefined,
        bindings: []
      });
    });

    it('should handle duplicate space names', async () => {
      mockLoadStore.mockResolvedValue(storeOf([{ name: 'test-space', email: 'existing@example.com', userName: 'Existing', sshKeyPath: '' }]));

      mockInput
        .mockResolvedValueOnce('Test Space')
        .mockResolvedValueOnce('test@example.com')
        .mockResolvedValueOnce('Test User');

      await addSpace();

      expect(mockSaveStore).not.toHaveBeenCalled();
    });

    it('should handle SSH key generation without switch', async () => {
      mockLoadStore.mockResolvedValue(storeOf([]));
      (mockFs.readFile as unknown as jest.Mock).mockResolvedValue(mockPublicKey);

      mockInput
        .mockResolvedValueOnce('Test Space')
        .mockResolvedValueOnce('test@example.com')
        .mockResolvedValueOnce('Test User');

      mockConfirm
        .mockResolvedValueOnce(true) // Generate SSH key
        .mockResolvedValueOnce(false); // Don't switch to new space

      mockPassword.mockResolvedValueOnce('');
      mockGenerateKey.mockResolvedValue(mockKeyInfo);
      mockCopyToClipboard.mockResolvedValue('copied');

      await addSpace();

      expect(mockCopyToClipboard).toHaveBeenCalledWith(mockPublicKey);
    });

    it('should default the algorithm to ed25519 with no algorithm prompt, and pass directory/comment/passphrase', async () => {
      mockLoadStore.mockResolvedValue(storeOf([]));
      (mockFs.readFile as unknown as jest.Mock).mockResolvedValue(mockPublicKey);

      mockInput
        .mockResolvedValueOnce('Test Space')
        .mockResolvedValueOnce('test@example.com')
        .mockResolvedValueOnce('Test User');

      mockConfirm
        .mockResolvedValueOnce(true) // Generate SSH key
        .mockResolvedValueOnce(false); // Don't switch to new space

      mockPassword.mockResolvedValueOnce('hunter2');
      mockGenerateKey.mockResolvedValue(mockKeyInfo);
      mockCopyToClipboard.mockResolvedValue('copied');

      await addSpace();

      expect(mockGenerateKey).toHaveBeenCalledWith({
        directory: path.join('/mock/home', '.dss', 'spaces', 'test-space'),
        algorithm: 'ed25519',
        comment: 'test@example.com',
        passphrase: 'hunter2'
      });
      expect(mockSelect).not.toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining('algorithm')
      }));
    });

    it('should prompt for a passphrase (mask on, empty default) only after confirming key generation', async () => {
      mockLoadStore.mockResolvedValue(storeOf([]));
      (mockFs.readFile as unknown as jest.Mock).mockResolvedValue(mockPublicKey);

      mockInput
        .mockResolvedValueOnce('Test Space')
        .mockResolvedValueOnce('test@example.com')
        .mockResolvedValueOnce('Test User');

      mockConfirm
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      mockPassword.mockResolvedValueOnce('');
      mockGenerateKey.mockResolvedValue(mockKeyInfo);
      mockCopyToClipboard.mockResolvedValue('copied');

      await addSpace();

      expect(mockPassword).toHaveBeenCalledWith(expect.objectContaining({
        message: 'Passphrase for the key (empty for none):',
        mask: true
      }));
    });

    it('should not prompt for a passphrase when key generation is declined', async () => {
      mockLoadStore.mockResolvedValue(storeOf([]));

      mockInput
        .mockResolvedValueOnce('Test Space')
        .mockResolvedValueOnce('test@example.com')
        .mockResolvedValueOnce('Test User');

      mockConfirm
        .mockResolvedValueOnce(false) // Don't generate SSH key
        .mockResolvedValueOnce(false); // Don't switch to new space

      await addSpace();

      expect(mockPassword).not.toHaveBeenCalled();
      expect(mockGenerateKey).not.toHaveBeenCalled();
    });

    it('should treat a cancelled passphrase prompt as empty (cancellation-safe)', async () => {
      mockLoadStore.mockResolvedValue(storeOf([]));
      (mockFs.readFile as unknown as jest.Mock).mockResolvedValue(mockPublicKey);

      mockInput
        .mockResolvedValueOnce('Test Space')
        .mockResolvedValueOnce('test@example.com')
        .mockResolvedValueOnce('Test User');

      mockConfirm
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      mockPassword.mockRejectedValueOnce(new ExitPromptError('User force closed the prompt with 0 null'));
      mockGenerateKey.mockResolvedValue(mockKeyInfo);
      mockCopyToClipboard.mockResolvedValue('copied');

      await addSpace();

      expect(mockGenerateKey).toHaveBeenCalledWith(expect.objectContaining({ passphrase: '' }));
    });

    it('prompts for a Git host after the username, defaulting to github.com, and persists a selected non-default host', async () => {
      mockLoadStore.mockResolvedValue(storeOf([]));

      mockInput
        .mockResolvedValueOnce('Test Space')
        .mockResolvedValueOnce('test@example.com')
        .mockResolvedValueOnce('Test User');
      mockSelect.mockResolvedValueOnce('gitlab.com');
      mockConfirm
        .mockResolvedValueOnce(false) // Don't generate SSH key
        .mockResolvedValueOnce(false); // Don't switch to new space

      await addSpace();

      expect(mockSelect).toHaveBeenCalledWith(expect.objectContaining({
        message: 'Git host:',
        default: 'github.com'
      }));
      expect(mockSaveStore).toHaveBeenLastCalledWith(expect.objectContaining({
        identities: [expect.objectContaining({ name: 'test-space', host: 'gitlab.com' })]
      }));
    });

    it('supports a custom host via the "Other…" select choice', async () => {
      mockLoadStore.mockResolvedValue(storeOf([]));

      mockInput
        .mockResolvedValueOnce('Test Space')
        .mockResolvedValueOnce('test@example.com')
        .mockResolvedValueOnce('Test User')
        .mockResolvedValueOnce('git.example.com'); // custom host input
      mockSelect.mockResolvedValueOnce('__other__');
      mockConfirm
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false);

      await addSpace();

      expect(mockSaveStore).toHaveBeenLastCalledWith(expect.objectContaining({
        identities: [expect.objectContaining({ name: 'test-space', host: 'git.example.com' })]
      }));
    });

    it('uses the host-aware key-settings link (not a hardcoded GitHub one) in the success box', async () => {
      mockLoadStore.mockResolvedValue(storeOf([]));
      (mockFs.readFile as unknown as jest.Mock).mockResolvedValue(mockPublicKey);

      mockInput
        .mockResolvedValueOnce('Test Space')
        .mockResolvedValueOnce('test@example.com')
        .mockResolvedValueOnce('Test User');
      mockSelect.mockResolvedValueOnce('gitlab.com');
      mockConfirm
        .mockResolvedValueOnce(true) // Generate SSH key
        .mockResolvedValueOnce(false); // Don't switch to new space
      mockPassword.mockResolvedValueOnce('');
      mockGenerateKey.mockResolvedValue(mockKeyInfo);
      mockCopyToClipboard.mockResolvedValue('copied');

      await addSpace();

      const calls = (console.log as jest.Mock).mock.calls.flat();
      expect(calls.some((call) => call && call.includes && call.includes('https://gitlab.com/-/user_settings/ssh_keys'))).toBe(true);
      expect(calls.some((call) => call && call.includes && call.includes('github.com/settings/keys'))).toBe(false);
    });
  });

  describe('listSpaces', () => {
    it('should list spaces with active space indicator', async () => {
      mockLoadStore.mockResolvedValue(storeOf([
          { name: 'space1', email: 'user1@example.com', userName: 'User1', sshKeyPath: '' },
          { name: 'space2', email: 'user2@example.com', userName: 'User2', sshKeyPath: '' }
        ], 'space1'));

      await listSpaces();

      // Check that the table was printed - looking for the active space indicator
      const calls = (console.log as jest.Mock).mock.calls.flat();
      const hasActiveSpace = calls.some(call => call && call.includes && call.includes('🔥 space1'));
      expect(hasActiveSpace).toBe(true);
    });

    it('should handle no spaces', async () => {
      mockLoadStore.mockResolvedValue(storeOf([]));

      await listSpaces();

      expect(console.log).toHaveBeenCalledTimes(2);
      expect(console.log).toHaveBeenNthCalledWith(1, expect.stringContaining('No spaces have been added yet.'));
      expect(console.log).toHaveBeenNthCalledWith(2, expect.stringContaining('dss add'));
    });

    it('shows each space\'s host in a Host column', async () => {
      mockLoadStore.mockResolvedValue(storeOf([
        { name: 'work', email: 'w@example.com', userName: 'W', host: 'gitlab.com', sshKeyPath: '' }
      ]));

      await listSpaces();

      const calls = (console.log as jest.Mock).mock.calls.flat();
      const hasHostColumn = calls.some(call => call && call.includes && call.includes('Host'));
      const hasHostValue = calls.some(call => call && call.includes && call.includes('gitlab.com'));
      expect(hasHostColumn).toBe(true);
      expect(hasHostValue).toBe(true);
    });
  });

  describe('switchSpace', () => {
    const mockSpace = {
      name: 'test-space',
      email: 'test@example.com',
      userName: 'Test User',
      sshKeyPath: mockSshKeyPath
    };

    it('should switch to a space successfully (includeIf-first: writeActiveGitconfig + ensureGlobalInclude, no direct git config writes)', async () => {
      mockLoadStore.mockResolvedValue(storeOf([mockSpace]));
      mockConfirm.mockResolvedValue(false); // Don't test GitHub access

      await switchSpace('test-space');

      expect(mockWriteActiveGitconfig).toHaveBeenCalledWith(
        expect.objectContaining({ userName: mockSpace.userName, email: mockSpace.email })
      );
      expect(mockEnsureGlobalInclude).toHaveBeenCalled();
      // switch no longer calls `git config --global user.name/email` directly.
      expect(mockExecFile).not.toHaveBeenCalledWith(
        'git',
        ['config', '--global', 'user.name', mockSpace.userName],
        expect.any(Function)
      );
      expect(mockExecFile).not.toHaveBeenCalledWith(
        'git',
        ['config', '--global', 'user.email', mockSpace.email],
        expect.any(Function)
      );
      expect(mockAddToAgent).toHaveBeenCalledWith(mockSpace.sshKeyPath);
      expect(mockSetHostSSHKey).toHaveBeenCalledWith(mockSpace.sshKeyPath, 'github.com');
      expect(mockSaveStore).toHaveBeenCalledWith(storeOf([mockSpace], 'test-space'));
    });

    it('calls setHostSSHKey and testHostAccess with the space\'s configured (non-default) host', async () => {
      const glSpace = { ...mockSpace, host: 'gitlab.com' };
      mockLoadStore.mockResolvedValue(storeOf([glSpace]));
      mockConfirm.mockResolvedValue(true); // Test access
      mockTestHostAccess.mockResolvedValue();

      await switchSpace('test-space');

      expect(mockSetHostSSHKey).toHaveBeenCalledWith(glSpace.sshKeyPath, 'gitlab.com');
      expect(mockTestHostAccess).toHaveBeenCalledWith(glSpace.sshKeyPath, 'gitlab.com');
    });

    it('should handle space not found', async () => {
      mockLoadStore.mockResolvedValue(storeOf([]));

      await switchSpace('nonexistent-space');

      expect(console.log).toHaveBeenCalledTimes(2);
      expect(console.log).toHaveBeenNthCalledWith(1, expect.stringContaining('No spaces have been added yet.'));
      expect(console.log).toHaveBeenNthCalledWith(2, expect.stringContaining('dss add'));
    });

    it('should handle already active space', async () => {
      mockLoadStore.mockResolvedValue(storeOf([mockSpace], 'test-space'));

      await switchSpace('test-space');

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('is already active'));
    });

    it('should prompt for space selection when none provided', async () => {
      mockLoadStore.mockResolvedValue(storeOf([mockSpace]));
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
      mockLoadStore.mockResolvedValue(storeOf([keylessSpace]));

      await switchSpace('keyless-space');

      expect(mockWriteActiveGitconfig).toHaveBeenCalledWith(
        expect.objectContaining({ userName: keylessSpace.userName, email: keylessSpace.email })
      );
      expect(mockEnsureGlobalInclude).toHaveBeenCalled();
      expect(mockAddToAgent).not.toHaveBeenCalled();
      expect(mockSaveStore).toHaveBeenCalledWith(storeOf([keylessSpace], 'keyless-space'));

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
      mockLoadStore.mockResolvedValue(storeOf([keylessSpace]));

      await switchSpace('keyless-space', { dryRun: true });

      const calls = (console.log as jest.Mock).mock.calls.flat();
      expect(calls.some(call => call && call.includes && call.includes('SSH'))).toBe(false);
      expect(mockSaveStore).not.toHaveBeenCalled();
    });

    it('should return null (no throw) when the interactive select is cancelled', async () => {
      mockLoadStore.mockResolvedValue(storeOf([mockSpace]));
      mockSelect.mockRejectedValue(new ExitPromptError('User force closed the prompt with 0 null'));

      await expect(switchSpace()).resolves.toBeUndefined();
      expect(mockSaveStore).not.toHaveBeenCalled();
    });

    it('should rethrow non-cancellation errors from the interactive select', async () => {
      mockLoadStore.mockResolvedValue(storeOf([mockSpace]));
      mockSelect.mockRejectedValue(new Error('boom'));

      await expect(switchSpace()).rejects.toThrow('boom');
    });

    it('should set process.exitCode = 1 when the target space is not found', async () => {
      mockLoadStore.mockResolvedValue(storeOf([mockSpace]));

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
      mockLoadStore.mockResolvedValue(storeOf([legacySpace]));
      mockConfirm.mockResolvedValue(false);

      await switchSpace('test-space');

      expect(mockSaveStore).toHaveBeenCalledWith(storeOf([legacySpace], 'Test Space'));
    });

    it('passes an SSH key path containing a space to addToAgent unchanged (regression)', async () => {
      const spacedKeyPath = '/tmp/my dir/id_rsa';
      const spacedSpace = {
        name: 'spaced-space',
        email: 'spaced@example.com',
        userName: 'Spaced User',
        sshKeyPath: spacedKeyPath
      };
      mockLoadStore.mockResolvedValue(storeOf([spacedSpace]));
      mockConfirm.mockResolvedValue(false);

      await switchSpace('spaced-space');

      expect(mockAddToAgent).toHaveBeenCalledWith(spacedKeyPath);
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
      mockLoadStore.mockResolvedValue(storeOf([mockSpace]));
      mockSelect.mockResolvedValue('test-space');
      mockConfirm.mockResolvedValue(true);

      await removeSpace();

      expect(mockSaveStore).toHaveBeenCalledWith(storeOf([]));
      const calls = (console.log as jest.Mock).mock.calls.flat();
      const hasRemoveMessage = calls.some(call =>
        call && call.includes && call.includes("has been removed successfully")
      );
      expect(hasRemoveMessage).toBe(true);
    });

    it('should not call removeSSHKeyFromAgent when removing a keyless space (no spurious ssh-add -d error)', async () => {
      const keylessSpace = { ...mockSpace, sshKeyPath: '' };
      mockLoadStore.mockResolvedValue(storeOf([keylessSpace]));
      mockSelect.mockResolvedValue('test-space');
      mockConfirm.mockResolvedValue(true);

      await removeSpace();

      expect(mockRemoveSSHKeyFromAgent).not.toHaveBeenCalled();
      expect(mockSaveStore).toHaveBeenCalledWith(storeOf([]));
    });

    it('should reflect a keyless space in the dry-run preview instead of promising agent removal', async () => {
      const keylessSpace = { ...mockSpace, sshKeyPath: '' };
      mockLoadStore.mockResolvedValue(storeOf([keylessSpace]));
      mockSelect.mockResolvedValue('test-space');

      await removeSpace(undefined, { dryRun: true });

      const calls = (console.log as jest.Mock).mock.calls.flat();
      expect(calls.some(call => call && call.includes && call.includes('Would remove SSH key from agent'))).toBe(false);
      expect(calls.some(call => call && call.includes && call.includes('No SSH key configured'))).toBe(true);
    });

    it('should prevent removing active space', async () => {
      mockLoadStore.mockResolvedValue(storeOf([mockSpace], 'test-space'));
      mockSelect.mockResolvedValue('test-space');

      await removeSpace();

      // Check for the error message (UIHelper.error uses console.log with red color)
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining("Cannot remove the active space")
      );
    });

    it('should handle removal cancellation', async () => {
      mockLoadStore.mockResolvedValue(storeOf([mockSpace]));
      mockSelect.mockResolvedValue('test-space');
      mockConfirm.mockResolvedValue(false);

      await removeSpace();

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Removal cancelled')
      );
      expect(mockSaveStore).not.toHaveBeenCalled();
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
      mockLoadStore.mockResolvedValue(storeOf([legacySpace], 'Test Space'));

      await removeSpace('test-space');

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Cannot remove the active space')
      );
      expect(mockSaveStore).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });

    it('should find and remove a legacy raw-name space when looked up by its slug', async () => {
      const legacySpace = {
        name: 'Test Space',
        email: 'test@example.com',
        userName: 'Test User',
        sshKeyPath: mockSshKeyPath
      };
      mockLoadStore.mockResolvedValue(storeOf([legacySpace]));
      mockConfirm.mockResolvedValue(true);

      await removeSpace('test-space');

      expect(mockSaveStore).toHaveBeenCalledWith(storeOf([]));
    });

    it('should set process.exitCode = 1 when the named space is not found', async () => {
      mockLoadStore.mockResolvedValue(storeOf([mockSpace]));

      await removeSpace('does-not-exist');

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Space "does-not-exist" not found.'));
      expect(process.exitCode).toBe(1);
    });

    it('should set process.exitCode = 1 when the removal itself fails', async () => {
      mockLoadStore.mockResolvedValue(storeOf([mockSpace]));
      mockConfirm.mockResolvedValue(true);
      mockSaveStore.mockRejectedValue(new Error('disk full'));

      await removeSpace('test-space');

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Failed to remove space'));
      expect(process.exitCode).toBe(1);
    });

    it('warns (and leaves the registry entries) when the removed identity has registered bindings', async () => {
      mockLoadStore.mockResolvedValue({
        version: 2,
        identities: [typedFromSpace(mockSpace)],
        bindings: [
          { path: '/repos/one', identity: 'test-space' },
          { path: '/repos/two', identity: 'test-space' }
        ]
      });
      mockSelect.mockResolvedValue('test-space');
      mockConfirm.mockResolvedValue(true);

      await removeSpace();

      // Only unbind removes a registry entry — removeSpace must leave both.
      const finalStore = mockSaveStore.mock.calls[mockSaveStore.mock.calls.length - 1][0] as IStoreV2;
      expect(finalStore.bindings).toEqual([
        { path: '/repos/one', identity: 'test-space' },
        { path: '/repos/two', identity: 'test-space' }
      ]);

      const calls = (console.log as jest.Mock).mock.calls.flat();
      expect(calls.some(call => call && call.includes && call.includes('still bound to the removed identity "test-space"'))).toBe(true);
      expect(calls.some(call => call && call.includes && call.includes('/repos/one'))).toBe(true);
      expect(calls.some(call => call && call.includes && call.includes('/repos/two'))).toBe(true);
      expect(calls.some(call => call && call.includes && call.includes('dss unbind'))).toBe(true);
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
      mockLoadStore.mockResolvedValue(storeOf([mockSpace], 'test-space'));
      mockTestHostAccess.mockResolvedValue();

      await testSpace();

      expect(mockTestHostAccess).toHaveBeenCalledWith(mockSshKeyPath, 'github.com');
    });

    it('should resolve a non-default host onto testHostAccess', async () => {
      const workSpace = { ...mockSpace, host: 'gitlab.com' };
      mockLoadStore.mockResolvedValue(storeOf([workSpace], 'test-space'));
      mockTestHostAccess.mockResolvedValue();

      await testSpace();

      expect(mockTestHostAccess).toHaveBeenCalledWith(mockSshKeyPath, 'gitlab.com');
    });

    it('should handle space without SSH key', async () => {
      const spaceWithoutKey = { ...mockSpace, sshKeyPath: '' };
      mockLoadStore.mockResolvedValue(storeOf([spaceWithoutKey], 'test-space'));

      await testSpace();

      expect(console.log).toHaveBeenCalledTimes(2);
      expect(console.log).toHaveBeenNthCalledWith(1, expect.stringContaining('Space "test-space" does not have an associated SSH key.'));
      expect(console.log).toHaveBeenNthCalledWith(2, expect.stringContaining('dss bulk'));
    });

    it('should handle no spaces', async () => {
      mockLoadStore.mockResolvedValue(storeOf([]));

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
      mockLoadStore.mockResolvedValue(storeOf([mockSpace, otherSpace], 'test-space'));
      mockTestHostAccess.mockResolvedValue();

      await testSpace('other-space');

      expect(mockTestHostAccess).toHaveBeenCalledWith(otherSpace.sshKeyPath, 'github.com');
    });

    it('should NOT fall back to the active space when a named space does not exist', async () => {
      mockLoadStore.mockResolvedValue(storeOf([mockSpace], 'test-space'));

      await testSpace('does-not-exist');

      expect(mockTestHostAccess).not.toHaveBeenCalled();
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
      mockLoadStore.mockResolvedValue(storeOf([legacySpace], 'Test Space'));
      mockTestHostAccess.mockResolvedValue();

      await testSpace('test-space');

      expect(mockTestHostAccess).toHaveBeenCalledWith(mockSshKeyPath, 'github.com');
    });
  });

  describe('modifySpace', () => {
    const mockSpace = {
      name: 'test-space',
      email: 'test@example.com',
      userName: 'Test User',
      sshKeyPath: mockSshKeyPath
    };

    it('should skip the "which space" select prompt when a space name is provided (host select still fires)', async () => {
      mockLoadStore.mockResolvedValue(storeOf([mockSpace]));

      mockInput
        .mockResolvedValueOnce(mockSpace.name)
        .mockResolvedValueOnce(mockSpace.email)
        .mockResolvedValueOnce(mockSpace.userName);
      mockSelect.mockResolvedValueOnce('github.com');

      await modifySpace('test-space');

      expect(mockSelect).not.toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining('Which space')
      }));
      expect(mockSelect).toHaveBeenCalledWith(expect.objectContaining({ message: 'Git host:' }));
    });

    it('should error when the named space does not exist', async () => {
      mockLoadStore.mockResolvedValue(storeOf([mockSpace]));

      await modifySpace('nonexistent-space');

      expect(mockSelect).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Space "nonexistent-space" not found.'));
    });

    it('should still prompt for selection when no name is provided', async () => {
      mockLoadStore.mockResolvedValue(storeOf([mockSpace]));
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
      mockLoadStore.mockResolvedValue(storeOf([spaceToRename], 'test-space'));
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
      expect(mockSaveStore).toHaveBeenCalledWith(storeOf([{
          name: 'new-name',
          email: mockSpace.email,
          userName: mockSpace.userName,
          sshKeyPath: newSshKeyPath
        }], 'new-name'));
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
      mockLoadStore.mockResolvedValue(storeOf([keylessSpace], 'other-active'));

      mockInput
        .mockResolvedValueOnce('New Name')
        .mockResolvedValueOnce(keylessSpace.email)
        .mockResolvedValueOnce(keylessSpace.userName);

      await modifySpace('test-space');

      expect(mockFs.move).not.toHaveBeenCalled();
      expect(mockSaveStore).toHaveBeenCalledWith(storeOf([{ ...keylessSpace, name: 'new-name' }], 'other-active'));
    });

    it('should re-apply global git config when the active space email/userName change', async () => {
      const activeSpace = {
        name: 'test-space',
        email: 'test@example.com',
        userName: 'Test User',
        sshKeyPath: mockSshKeyPath
      };
      mockLoadStore.mockResolvedValue(storeOf([activeSpace], 'test-space'));

      mockInput
        .mockResolvedValueOnce(activeSpace.name) // name unchanged
        .mockResolvedValueOnce('new-email@example.com')
        .mockResolvedValueOnce('New User Name');

      await modifySpace('test-space');

      expect(mockWriteActiveGitconfig).toHaveBeenCalledWith(
        expect.objectContaining({ userName: 'New User Name', email: 'new-email@example.com' })
      );
      expect(mockEnsureGlobalInclude).toHaveBeenCalled();
      expect(mockExecFile).not.toHaveBeenCalledWith(
        'git',
        ['config', '--global', 'user.name', 'New User Name'],
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
      mockLoadStore.mockResolvedValue(storeOf([activeSpace], 'test-space'));
      mockEnsureGlobalInclude.mockRejectedValueOnce(new Error('git not found'));

      mockInput
        .mockResolvedValueOnce(activeSpace.name)
        .mockResolvedValueOnce('new-email@example.com')
        .mockResolvedValueOnce(activeSpace.userName);

      await modifySpace('test-space');

      // Config is persisted with the new email BEFORE the git re-apply runs,
      // so disk state isn't left inconsistent when the re-apply fails.
      expect(mockSaveStore).toHaveBeenCalledWith(storeOf([{ ...activeSpace, email: 'new-email@example.com' }], 'test-space'));
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
      mockLoadStore.mockResolvedValue(storeOf([activeSpace], 'test-space'));
      (mockFs.pathExists as unknown as jest.Mock).mockResolvedValue(true);
      (mockFs.move as unknown as jest.Mock).mockResolvedValue(undefined);
      mockEnsureGlobalInclude.mockRejectedValueOnce(new Error('git not found'));

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
      expect(mockSaveStore).toHaveBeenCalledWith(storeOf([{
          name: 'new-name',
          email: 'new-email@example.com',
          userName: activeSpace.userName,
          sshKeyPath: newSshKeyPath
        }], 'new-name'));
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
      mockLoadStore.mockResolvedValue(storeOf([activeSpace], 'test-space'));
      (mockFs.pathExists as unknown as jest.Mock).mockResolvedValue(true);
      (mockFs.move as unknown as jest.Mock).mockRejectedValue(new Error('EACCES: permission denied'));

      mockInput
        .mockResolvedValueOnce('New Name')
        .mockResolvedValueOnce(activeSpace.email)
        .mockResolvedValueOnce(activeSpace.userName);

      await expect(modifySpace('test-space')).resolves.toBeUndefined();

      expect(mockSaveStore).not.toHaveBeenCalled();
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
      mockLoadStore.mockResolvedValue(storeOf([spaceToRename, otherSpace]));

      mockInput
        .mockResolvedValueOnce('Other Space') // slugifies to "other-space", collides
        .mockResolvedValueOnce(spaceToRename.email)
        .mockResolvedValueOnce(spaceToRename.userName);

      await modifySpace('test-space');

      expect(mockFs.move).not.toHaveBeenCalled();
      expect(mockSaveStore).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Another space with the name "Other Space" already exists.'));
      expect(process.exitCode).toBe(1);
    });

    it('should not abort the edit or attempt a key move when the typed name is only cosmetically different (slug unchanged, incl. legacy raw names)', async () => {
      // Regression: a rename whose slug is unchanged used to fire the rename
      // branch on a raw-name comparison, derive the move destination from
      // the slug, and hit fs-extra's "Source and destination must not be
      // the same" because oldKeyDir === newKeyDir — aborting before the
      // email/userName edits below were persisted.
      const legacySpace = {
        name: 'Test Space',
        email: 'test@example.com',
        userName: 'Test User',
        sshKeyPath: mockSshKeyPath
      };
      mockLoadStore.mockResolvedValue(storeOf([legacySpace]));

      mockInput
        .mockResolvedValueOnce('test-space') // types the normalized slug; same slug as "Test Space"
        .mockResolvedValueOnce('new-email@example.com')
        .mockResolvedValueOnce(legacySpace.userName);

      await modifySpace('Test Space');

      expect(mockFs.pathExists).not.toHaveBeenCalled();
      expect(mockFs.move).not.toHaveBeenCalled();
      expect(mockSaveStore).toHaveBeenCalledWith(storeOf([{
          name: 'Test Space',
          email: 'new-email@example.com',
          userName: legacySpace.userName,
          sshKeyPath: mockSshKeyPath
        }]));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('updated successfully'));
      expect(process.exitCode).toBeUndefined();
    });

    it('should warn that repo bindings may reference the old key path when a rename actually moves the key directory', async () => {
      const spaceToRename = {
        name: 'test-space',
        email: 'test@example.com',
        userName: 'Test User',
        sshKeyPath: mockSshKeyPath
      };
      mockLoadStore.mockResolvedValue(storeOf([spaceToRename]));
      (mockFs.pathExists as unknown as jest.Mock).mockResolvedValue(true);
      (mockFs.move as unknown as jest.Mock).mockResolvedValue(undefined);

      mockInput
        .mockResolvedValueOnce('New Name')
        .mockResolvedValueOnce(spaceToRename.email)
        .mockResolvedValueOnce(spaceToRename.userName);

      await modifySpace('test-space');

      const calls = (console.log as jest.Mock).mock.calls.flat();
      expect(calls.some(call =>
        call && call.includes && call.includes('dss bind') && call.includes('old key path')
      )).toBe(true);
    });

    it('renames registered binding entries and re-invokes bindRepository per live path on rename, warning per dead path and printing a summary (skipping the legacy blanket warning)', async () => {
      const spaceToRename = {
        name: 'test-space',
        email: 'test@example.com',
        userName: 'Test User',
        sshKeyPath: mockSshKeyPath
      };
      mockLoadStore.mockResolvedValue({
        version: 2,
        identities: [typedFromSpace(spaceToRename)],
        bindings: [
          { path: '/repos/live', identity: 'test-space' },
          { path: '/repos/dead', identity: 'test-space' }
        ]
      });
      (mockFs.pathExists as unknown as jest.Mock).mockResolvedValue(true);
      (mockFs.move as unknown as jest.Mock).mockResolvedValue(undefined);
      mockBindRepository.mockImplementation(async (repositoryPath: string) => {
        if (repositoryPath === '/repos/dead') {
          throw new Error('not a git repository');
        }
        return {} as any;
      });

      mockInput
        .mockResolvedValueOnce('New Name')
        .mockResolvedValueOnce(spaceToRename.email)
        .mockResolvedValueOnce(spaceToRename.userName);

      await modifySpace('test-space');

      expect(mockBindRepository).toHaveBeenCalledWith('/repos/live', expect.objectContaining({ name: 'new-name' }), {});
      expect(mockBindRepository).toHaveBeenCalledWith('/repos/dead', expect.objectContaining({ name: 'new-name' }), {});

      const finalStore = mockSaveStore.mock.calls[mockSaveStore.mock.calls.length - 1][0] as IStoreV2;
      expect(finalStore.bindings).toEqual([
        { path: '/repos/live', identity: 'new-name' },
        { path: '/repos/dead', identity: 'new-name' }
      ]);

      const calls = (console.log as jest.Mock).mock.calls.flat();
      expect(calls.some(call => call && call.includes && call.includes('Could not refresh binding for /repos/dead'))).toBe(true);
      expect(calls.some(call => call && call.includes && call.includes('Refreshed 1 binding(s); 1 need attention.'))).toBe(true);
      // Registered bindings exist, so the Phase 1 blanket warning is skipped.
      expect(calls.some(call => call && call.includes && call.includes('may still reference the old key path'))).toBe(false);
    });

    it('refreshes registered bindings on an email/userName-only change (no rename)', async () => {
      const spaceToEdit = {
        name: 'test-space',
        email: 'test@example.com',
        userName: 'Test User',
        sshKeyPath: mockSshKeyPath
      };
      mockLoadStore.mockResolvedValue({
        version: 2,
        identities: [typedFromSpace(spaceToEdit)],
        bindings: [{ path: '/repos/live', identity: 'test-space' }]
      });
      mockBindRepository.mockResolvedValue({} as any);

      mockInput
        .mockResolvedValueOnce(spaceToEdit.name)
        .mockResolvedValueOnce('new-email@example.com')
        .mockResolvedValueOnce(spaceToEdit.userName);

      await modifySpace('test-space');

      expect(mockBindRepository).toHaveBeenCalledWith(
        '/repos/live',
        expect.objectContaining({ name: 'test-space', email: 'new-email@example.com' }),
        {}
      );

      const finalStore = mockSaveStore.mock.calls[mockSaveStore.mock.calls.length - 1][0] as IStoreV2;
      expect(finalStore.bindings).toEqual([{ path: '/repos/live', identity: 'test-space' }]);

      const calls = (console.log as jest.Mock).mock.calls.flat();
      expect(calls.some(call => call && call.includes && call.includes('Refreshed 1 binding(s); 0 need attention.'))).toBe(true);
    });

    it('prompts for the host with the current value as the select default, and makes no change when re-selecting it', async () => {
      const spaceWithHost = { ...mockSpace, host: 'gitlab.com' };
      mockLoadStore.mockResolvedValue(storeOf([spaceWithHost]));

      mockInput
        .mockResolvedValueOnce(spaceWithHost.name)
        .mockResolvedValueOnce(spaceWithHost.email)
        .mockResolvedValueOnce(spaceWithHost.userName);
      mockSelect.mockResolvedValueOnce('gitlab.com');

      await modifySpace('test-space');

      expect(mockSelect).toHaveBeenCalledWith(expect.objectContaining({
        message: 'Git host:',
        default: 'gitlab.com'
      }));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('No changes were made to the space.'));
      expect(mockSaveStore).toHaveBeenCalledWith(storeOf([spaceWithHost]));
    });

    it('persists an edited host and reports the update as made', async () => {
      const spaceWithHost = { ...mockSpace, host: 'gitlab.com' };
      mockLoadStore.mockResolvedValue(storeOf([spaceWithHost]));

      mockInput
        .mockResolvedValueOnce(spaceWithHost.name)
        .mockResolvedValueOnce(spaceWithHost.email)
        .mockResolvedValueOnce(spaceWithHost.userName);
      mockSelect.mockResolvedValueOnce('bitbucket.org');

      await modifySpace('test-space');

      expect(mockSaveStore).toHaveBeenCalledWith(storeOf([{ ...spaceWithHost, host: 'bitbucket.org' }]));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('updated successfully'));
    });

    it('supports a custom host via the "Other…" select choice during edit', async () => {
      mockLoadStore.mockResolvedValue(storeOf([mockSpace]));

      mockInput
        .mockResolvedValueOnce(mockSpace.name)
        .mockResolvedValueOnce(mockSpace.email)
        .mockResolvedValueOnce(mockSpace.userName)
        .mockResolvedValueOnce('git.example.com'); // custom host input
      mockSelect.mockResolvedValueOnce('__other__');

      await modifySpace('test-space');

      expect(mockSaveStore).toHaveBeenCalledWith(storeOf([{ ...mockSpace, host: 'git.example.com' }]));
    });
  });

  describe('persistConfig identity metadata preservation (regression)', () => {
    // persistConfig used to wholesale-replace store.identities from the
    // ISpace[] view on every write, which — as ISpace carries no host or
    // key.fingerprint/createdAt fields — silently reset an untouched
    // identity's host to 'github.com' and dropped its key metadata any time
    // a *different* identity was edited. Guards against that regressing.
    it('keeps an untouched identity\'s host, key fingerprint, and key createdAt when another identity is edited', async () => {
      const identityA = {
        name: 'space-a',
        email: 'a@example.com',
        userName: 'A User',
        host: 'github.com',
        key: { path: '/mock/home/.dss/spaces/space-a/id_rsa', algorithm: 'rsa' as const }
      };
      const identityB = {
        name: 'space-b',
        email: 'b@example.com',
        userName: 'B User',
        host: 'gitlab.com',
        key: {
          path: '/mock/home/.dss/spaces/space-b/id_ed25519',
          algorithm: 'ed25519' as const,
          fingerprint: 'SHA256:deadbeef',
          createdAt: '2024-01-01T00:00:00.000Z'
        }
      };
      mockLoadStore.mockResolvedValue({
        version: 2,
        identities: [identityA, identityB],
        bindings: []
      });

      mockInput
        .mockResolvedValueOnce(identityA.name) // name unchanged
        .mockResolvedValueOnce('new-a-email@example.com') // email changed
        .mockResolvedValueOnce(identityA.userName); // userName unchanged

      await modifySpace('space-a');

      expect(mockSaveStore).toHaveBeenCalledWith({
        version: 2,
        identities: [
          { ...identityA, email: 'new-a-email@example.com' },
          identityB
        ],
        active: undefined,
        bindings: []
      });
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
      mockLoadStore.mockResolvedValue(storeOf([mockSpace], 'test-space'));
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

    it('prints a Host status row, defaulting to github.com when unset', async () => {
      const printStatusSpy = jest.spyOn(UIHelper, 'printStatus');

      await inspectSpace('test-space');

      const hostCall = printStatusSpy.mock.calls.find(call => call[0] === 'Host');
      expect(hostCall?.[1]).toBe('github.com');
      printStatusSpy.mockRestore();
    });

    it('prints a non-default Host status row', async () => {
      mockLoadStore.mockResolvedValue(storeOf([{ ...mockSpace, host: 'bitbucket.org' }], 'test-space'));
      const printStatusSpy = jest.spyOn(UIHelper, 'printStatus');

      await inspectSpace('test-space');

      const hostCall = printStatusSpy.mock.calls.find(call => call[0] === 'Host');
      expect(hostCall?.[1]).toBe('bitbucket.org');
      printStatusSpy.mockRestore();
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
