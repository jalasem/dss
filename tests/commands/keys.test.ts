import fs from 'fs-extra';
import { generateKey } from '../../src/infra/keys';
import { addToAgent } from '../../src/infra/ssh';
import { copyToClipboard } from '../../src/infra/clipboard';
import { confirm } from '@inquirer/prompts';
import { IIdentity, IKeyInfo, IStoreV2 } from '../../src/core/types';
import { UIHelper } from '../../src/commands/ui';
import { UsageError } from '../../src/commands/prompts';

jest.mock('fs-extra');
jest.mock('@inquirer/prompts', () => ({
  confirm: jest.fn(),
  select: jest.fn(),
  input: jest.fn(),
  password: jest.fn(),
  checkbox: jest.fn()
}));
jest.mock('../../src/infra/keys');
jest.mock('../../src/infra/ssh');
jest.mock('../../src/infra/clipboard');
jest.mock('../../src/infra/git', () => ({
  writeIdentityGitconfig: jest.fn()
}));
jest.mock('../../src/infra/store', () => {
  const actual = jest.requireActual('../../src/infra/store');
  return {
    ...actual,
    loadStore: jest.fn(),
    saveStore: jest.fn()
  };
});
// keys.ts calls reapplyActiveIdentity (src/commands/spaces.ts) when rotating
// the active identity's key. Importing the real spaces.ts here would pull in
// its real infra/git.ts (unmocked child_process) — a real `git config
// --global --add include.path ...` against the machine's actual ~/.gitconfig
// the moment a rotateKey test's identity is active. Stub the whole module.
jest.mock('../../src/commands/spaces', () => ({
  reapplyActiveIdentity: jest.fn(),
  refreshRegisteredBindings: jest.fn()
}));

const { loadStore, saveStore } = require('../../src/infra/store');
const { reapplyActiveIdentity, refreshRegisteredBindings } = require('../../src/commands/spaces');
const { writeIdentityGitconfig } = require('../../src/infra/git');
const { showKey, copyKey, rotateKey, keyCommand } = require('../../src/commands/keys');

const mockLoadStore = loadStore as jest.MockedFunction<() => Promise<IStoreV2>>;
const mockSaveStore = saveStore as jest.MockedFunction<(store: IStoreV2) => Promise<void>>;
const mockGenerateKey = generateKey as jest.MockedFunction<typeof generateKey>;
const mockAddToAgent = addToAgent as jest.MockedFunction<typeof addToAgent>;
const mockCopyToClipboard = copyToClipboard as jest.MockedFunction<typeof copyToClipboard>;
const mockConfirm = confirm as jest.MockedFunction<typeof confirm>;
const mockFs = fs as jest.Mocked<typeof fs>;
const mockReapplyActiveIdentity = reapplyActiveIdentity as jest.MockedFunction<(space: unknown, store: IStoreV2) => Promise<void>>;
const mockRefreshRegisteredBindings = refreshRegisteredBindings as jest.MockedFunction<
  (matchingBindings: unknown[], space: unknown) => Promise<{ refreshed: number; needsAttention: number }>
>;
const mockWriteIdentityGitconfig = writeIdentityGitconfig as jest.MockedFunction<(identity: unknown) => Promise<void>>;

function storeWith(
  identities: IIdentity[],
  active?: string,
  bindings: IStoreV2['bindings'] = [],
  rules: IStoreV2['rules'] = []
): IStoreV2 {
  return { version: 2, identities, active, bindings, rules };
}

describe('commands/keys', () => {
  const keyedIdentity: IIdentity = {
    name: 'test-space',
    email: 'test@example.com',
    userName: 'Test User',
    host: 'github.com',
    key: {
      path: '/mock/home/.dss/spaces/test-space/id_ed25519',
      algorithm: 'ed25519',
      fingerprint: 'SHA256:abc123',
      createdAt: '2024-01-01T00:00:00.000Z'
    }
  };

  const keylessIdentity: IIdentity = {
    name: 'keyless-space',
    email: 'keyless@example.com',
    userName: 'Keyless User',
    host: 'github.com'
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation();
    (mockFs.readFile as unknown as jest.Mock).mockResolvedValue('ssh-ed25519 AAAA... test@example.com');
    mockCopyToClipboard.mockResolvedValue('copied');
    mockRefreshRegisteredBindings.mockResolvedValue({ refreshed: 0, needsAttention: 0 });
    mockWriteIdentityGitconfig.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  describe('identity resolution', () => {
    it('resolves a named identity via slug-aware lookup', async () => {
      mockLoadStore.mockResolvedValue(storeWith([keyedIdentity]));

      await showKey('test-space');

      expect(mockFs.readFile).toHaveBeenCalledWith(`${keyedIdentity.key!.path}.pub`, 'utf8');
      expect(process.exitCode).toBeUndefined();
    });

    it('fails with exit 1 when a named identity is not found', async () => {
      mockLoadStore.mockResolvedValue(storeWith([keyedIdentity]));

      await showKey('does-not-exist');

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Identity "does-not-exist" not found.'));
      expect(process.exitCode).toBe(1);
    });

    it('resolves the active identity when none is named', async () => {
      mockLoadStore.mockResolvedValue(storeWith([keyedIdentity], 'test-space'));

      await showKey();

      expect(mockFs.readFile).toHaveBeenCalledWith(`${keyedIdentity.key!.path}.pub`, 'utf8');
      expect(process.exitCode).toBeUndefined();
    });

    it('throws a UsageError (exit 2) naming the identityName argument when no identity is named and none is active — "missing input the user should have supplied", not an ordinary lookup failure', async () => {
      mockLoadStore.mockResolvedValue(storeWith([keyedIdentity]));

      await expect(showKey()).rejects.toThrow(UsageError);
      await expect(showKey()).rejects.toThrow('Missing required value: pass the identityName argument');
    });
  });

  describe('showKey', () => {
    it('fails with guidance to rotate when the identity has no key', async () => {
      mockLoadStore.mockResolvedValue(storeWith([keylessIdentity], 'keyless-space'));

      await showKey();

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('has no SSH key'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('dss key rotate keyless-space'));
      expect(process.exitCode).toBe(1);
    });

    it('prints the public key, algorithm, fingerprint, created date, and GitHub settings link', async () => {
      mockLoadStore.mockResolvedValue(storeWith([keyedIdentity], 'test-space'));

      await showKey();

      const calls = (console.log as jest.Mock).mock.calls.flat().join('\n');
      expect(calls).toContain('ssh-ed25519 AAAA... test@example.com');
      expect(calls).toContain('https://github.com/settings/keys');
    });

    it('links to the host-specific key-settings page for a non-GitHub identity', async () => {
      const gitlabIdentity: IIdentity = { ...keyedIdentity, name: 'gl-space', host: 'gitlab.com' };
      mockLoadStore.mockResolvedValue(storeWith([gitlabIdentity], 'gl-space'));

      await showKey();

      const calls = (console.log as jest.Mock).mock.calls.flat().join('\n');
      expect(calls).toContain('https://gitlab.com/-/user_settings/ssh_keys');
      expect(calls).not.toContain('github.com/settings/keys');
    });

    it('falls back to generic guidance for a host with no known key-settings page', async () => {
      const customIdentity: IIdentity = { ...keyedIdentity, name: 'custom-space', host: 'git.example.com' };
      mockLoadStore.mockResolvedValue(storeWith([customIdentity], 'custom-space'));

      await showKey();

      const calls = (console.log as jest.Mock).mock.calls.flat().join('\n');
      expect(calls).toContain('Add the public key to your git.example.com account.');
    });
  });

  describe('copyKey', () => {
    it('fails with guidance to rotate when the identity has no key', async () => {
      mockLoadStore.mockResolvedValue(storeWith([keylessIdentity], 'keyless-space'));

      await copyKey();

      expect(mockCopyToClipboard).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });

    it('copies the public key to the clipboard and confirms', async () => {
      mockLoadStore.mockResolvedValue(storeWith([keyedIdentity], 'test-space'));

      await copyKey();

      expect(mockCopyToClipboard).toHaveBeenCalledWith('ssh-ed25519 AAAA... test@example.com');
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('copied to clipboard'));
    });
  });

  describe('rotateKey', () => {
    const newKeyInfo: IKeyInfo = {
      path: '/mock/home/.dss/spaces/test-space/id_ed25519',
      algorithm: 'ed25519',
      fingerprint: 'SHA256:newfingerprint',
      createdAt: '2024-06-01T00:00:00.000Z'
    };

    it('does nothing and reports cancellation when the confirm prompt is declined (default false)', async () => {
      mockLoadStore.mockResolvedValue(storeWith([keyedIdentity], 'test-space'));
      mockConfirm.mockResolvedValue(false);

      await rotateKey();

      expect(mockConfirm).toHaveBeenCalledWith(expect.objectContaining({ default: false }));
      expect(mockGenerateKey).not.toHaveBeenCalled();
      expect(mockSaveStore).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('cancelled'));
    });

    it('warns that the old key stops working for the host when rotating an existing key', async () => {
      mockLoadStore.mockResolvedValue(storeWith([keyedIdentity], 'test-space'));
      mockConfirm.mockResolvedValue(false);

      await rotateKey();

      const message = mockConfirm.mock.calls[0][0].message as string;
      expect(message).toContain('stop working');
      expect(message).toContain(keyedIdentity.host);
    });

    it('generates a key with the same algorithm, updates store metadata, adds to agent, and copies the public key', async () => {
      mockLoadStore.mockResolvedValue(storeWith([keyedIdentity], 'test-space'));
      mockConfirm.mockResolvedValue(true);
      mockGenerateKey.mockResolvedValue(newKeyInfo);
      mockAddToAgent.mockResolvedValue(undefined);

      await rotateKey();

      expect(mockGenerateKey).toHaveBeenCalledWith(expect.objectContaining({
        algorithm: 'ed25519',
        comment: keyedIdentity.email
      }));
      expect(mockAddToAgent).toHaveBeenCalledWith(newKeyInfo.path);
      expect(mockCopyToClipboard).toHaveBeenCalledWith('ssh-ed25519 AAAA... test@example.com');
      expect(mockSaveStore).toHaveBeenCalled();

      const savedStore = mockSaveStore.mock.calls[0][0] as IStoreV2;
      expect(savedStore.identities[0].key).toEqual(newKeyInfo);

      const calls = (console.log as jest.Mock).mock.calls.flat().join('\n');
      expect(calls).toContain('https://github.com/settings/keys');
    });

    it('works for a keyless identity, creating its first key (ed25519 default)', async () => {
      mockLoadStore.mockResolvedValue(storeWith([keylessIdentity], 'keyless-space'));
      mockConfirm.mockResolvedValue(true);
      mockGenerateKey.mockResolvedValue({
        path: '/mock/home/.dss/spaces/keyless-space/id_ed25519',
        algorithm: 'ed25519',
        fingerprint: 'SHA256:firstkey',
        createdAt: '2024-06-01T00:00:00.000Z'
      });
      mockAddToAgent.mockResolvedValue(undefined);

      await rotateKey();

      expect(mockGenerateKey).toHaveBeenCalledWith(expect.objectContaining({ algorithm: 'ed25519' }));
      expect(mockSaveStore).toHaveBeenCalled();
      const savedStore = mockSaveStore.mock.calls[0][0] as IStoreV2;
      expect(savedStore.identities[0].key?.algorithm).toBe('ed25519');
      expect(process.exitCode).toBeUndefined();
    });

    it('fails with exit 1 when key generation itself fails', async () => {
      mockLoadStore.mockResolvedValue(storeWith([keyedIdentity], 'test-space'));
      mockConfirm.mockResolvedValue(true);
      mockGenerateKey.mockRejectedValue(new Error('ssh-keygen not found'));

      await rotateKey();

      expect(mockSaveStore).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Failed to generate SSH key'));
      expect(process.exitCode).toBe(1);
    });

    // Finding #5: rotating the ACTIVE identity's key can change its path
    // (keyless→keyed, or a migrated legacy-filename identity rotating onto
    // a standard-named file) — without re-applying, active.gitconfig/
    // ssh-config keep the old/absent key while `dss key rotate` reports
    // success.
    describe('active-identity re-apply (finding #5)', () => {
      it('calls reapplyActiveIdentity with the identity\'s NEW key path when rotating the active identity', async () => {
        mockLoadStore.mockResolvedValue(storeWith([keyedIdentity], 'test-space'));
        mockConfirm.mockResolvedValue(true);
        mockGenerateKey.mockResolvedValue(newKeyInfo);
        mockAddToAgent.mockResolvedValue(undefined);

        await rotateKey();

        expect(mockReapplyActiveIdentity).toHaveBeenCalledWith(
          expect.objectContaining({ name: 'test-space', sshKeyPath: newKeyInfo.path }),
          expect.anything()
        );
      });

      it('does not call reapplyActiveIdentity when rotating a non-active identity', async () => {
        const otherIdentity: IIdentity = { ...keyedIdentity, name: 'other-space' };
        mockLoadStore.mockResolvedValue(storeWith([keyedIdentity, otherIdentity], 'test-space'));
        mockConfirm.mockResolvedValue(true);
        mockGenerateKey.mockResolvedValue(newKeyInfo);
        mockAddToAgent.mockResolvedValue(undefined);

        await rotateKey('other-space');

        expect(mockReapplyActiveIdentity).not.toHaveBeenCalled();
      });

      it('warns (but the rotation still succeeds/persists) when the re-apply itself fails', async () => {
        mockLoadStore.mockResolvedValue(storeWith([keyedIdentity], 'test-space'));
        mockConfirm.mockResolvedValue(true);
        mockGenerateKey.mockResolvedValue(newKeyInfo);
        mockAddToAgent.mockResolvedValue(undefined);
        mockReapplyActiveIdentity.mockRejectedValueOnce(new Error('git not found'));

        const warningSpy = jest.spyOn(UIHelper, 'warning');

        await rotateKey();

        expect(warningSpy).toHaveBeenCalledWith(expect.stringContaining('re-applying the active identity'));
        expect(mockSaveStore).toHaveBeenCalled();
        expect(process.exitCode).toBeUndefined();

        warningSpy.mockRestore();
      });

      // Deferred-but-now-load-bearing regression: an active identity whose
      // key has a legacy non-standard filename (algorithm 'unknown') still
      // gets its ssh-agent add / active.gitconfig+ssh-config re-apply on
      // rotation, using the freshly generated key's own correct algorithm
      // and path — not the old, mismatched metadata.
      it('rotates an active identity with a legacy non-standard filename (algorithm "unknown"), re-applying with the correct new path/algorithm', async () => {
        const legacyIdentity: IIdentity = {
          name: 'legacy-space',
          email: 'legacy@example.com',
          userName: 'Legacy User',
          host: 'github.com',
          key: { path: '/mock/home/.dss/spaces/legacy-space/id_mystery', algorithm: 'unknown' }
        };
        mockLoadStore.mockResolvedValue(storeWith([legacyIdentity], 'legacy-space'));
        mockConfirm.mockResolvedValue(true);
        const rotatedKeyInfo: IKeyInfo = {
          path: '/mock/home/.dss/spaces/legacy-space/id_ed25519',
          algorithm: 'ed25519',
          fingerprint: 'SHA256:legacyrotated',
          createdAt: '2024-06-01T00:00:00.000Z'
        };
        mockGenerateKey.mockResolvedValue(rotatedKeyInfo);
        mockAddToAgent.mockResolvedValue(undefined);

        await rotateKey();

        // 'unknown' algorithm rotates onto ed25519 (same fallback as 'rsa'-only
        // detection), not carried through as-is.
        expect(mockGenerateKey).toHaveBeenCalledWith(expect.objectContaining({ algorithm: 'ed25519' }));

        const savedStore = mockSaveStore.mock.calls[0][0] as IStoreV2;
        expect(savedStore.identities[0].key).toEqual(rotatedKeyInfo);

        expect(mockReapplyActiveIdentity).toHaveBeenCalledWith(
          expect.objectContaining({ name: 'legacy-space', sshKeyPath: rotatedKeyInfo.path }),
          expect.anything()
        );
      });
    });

    // Task 5 item 1: rotate must refresh repo-local `dss link` bindings for
    // the rotated identity (via the same shared helper modifySpace's own
    // binding-refresh loop was extracted into) and, when the identity has
    // directory rules, regenerate its ~/.dss/identities/<slug>.gitconfig —
    // otherwise both keep pointing at the OLD key's sshCommand.
    describe('binding refresh + ruled-identity gitconfig (Task 5 item 1)', () => {
      it('re-runs refreshRegisteredBindings for each registered binding of the rotated identity, with the identity\'s NEW key path, and reports the refreshed count in the JSON payload', async () => {
        const bindings = [
          { path: '/repo/one', identity: 'test-space' },
          { path: '/repo/two', identity: 'test-space' }
        ];
        mockLoadStore.mockResolvedValue(storeWith([keyedIdentity], 'test-space', bindings));
        mockConfirm.mockResolvedValue(true);
        mockGenerateKey.mockResolvedValue(newKeyInfo);
        mockAddToAgent.mockResolvedValue(undefined);
        mockRefreshRegisteredBindings.mockResolvedValue({ refreshed: 2, needsAttention: 0 });

        await rotateKey();

        expect(mockRefreshRegisteredBindings).toHaveBeenCalledWith(
          bindings,
          expect.objectContaining({ name: 'test-space', sshKeyPath: newKeyInfo.path })
        );
        expect(process.exitCode).toBeUndefined();
      });

      it('does not call refreshRegisteredBindings when the identity has no registered bindings', async () => {
        mockLoadStore.mockResolvedValue(storeWith([keyedIdentity], 'test-space', []));
        mockConfirm.mockResolvedValue(true);
        mockGenerateKey.mockResolvedValue(newKeyInfo);
        mockAddToAgent.mockResolvedValue(undefined);

        await rotateKey();

        expect(mockRefreshRegisteredBindings).not.toHaveBeenCalled();
      });

      it('only refreshes bindings belonging to the rotated identity, ignoring bindings for other identities', async () => {
        const otherIdentity: IIdentity = { ...keyedIdentity, name: 'other-space' };
        const bindings = [
          { path: '/repo/mine', identity: 'test-space' },
          { path: '/repo/other', identity: 'other-space' }
        ];
        mockLoadStore.mockResolvedValue(storeWith([keyedIdentity, otherIdentity], 'test-space', bindings));
        mockConfirm.mockResolvedValue(true);
        mockGenerateKey.mockResolvedValue(newKeyInfo);
        mockAddToAgent.mockResolvedValue(undefined);
        mockRefreshRegisteredBindings.mockResolvedValue({ refreshed: 1, needsAttention: 0 });

        await rotateKey('test-space');

        expect(mockRefreshRegisteredBindings).toHaveBeenCalledWith(
          [{ path: '/repo/mine', identity: 'test-space' }],
          expect.anything()
        );
      });

      it('regenerates the ruled identity\'s gitconfig when the identity has directory rules', async () => {
        const rules = [{ dir: '/code/acme', identity: 'test-space' }];
        mockLoadStore.mockResolvedValue(storeWith([keyedIdentity], 'test-space', [], rules));
        mockConfirm.mockResolvedValue(true);
        mockGenerateKey.mockResolvedValue(newKeyInfo);
        mockAddToAgent.mockResolvedValue(undefined);

        await rotateKey();

        expect(mockWriteIdentityGitconfig).toHaveBeenCalledWith(
          expect.objectContaining({ name: 'test-space', key: newKeyInfo })
        );
      });

      it('does not regenerate any identity gitconfig when the identity has no directory rules', async () => {
        mockLoadStore.mockResolvedValue(storeWith([keyedIdentity], 'test-space', [], []));
        mockConfirm.mockResolvedValue(true);
        mockGenerateKey.mockResolvedValue(newKeyInfo);
        mockAddToAgent.mockResolvedValue(undefined);

        await rotateKey();

        expect(mockWriteIdentityGitconfig).not.toHaveBeenCalled();
      });

      it('warns but still succeeds when refreshing the ruled-identity gitconfig fails', async () => {
        const rules = [{ dir: '/code/acme', identity: 'test-space' }];
        mockLoadStore.mockResolvedValue(storeWith([keyedIdentity], 'test-space', [], rules));
        mockConfirm.mockResolvedValue(true);
        mockGenerateKey.mockResolvedValue(newKeyInfo);
        mockAddToAgent.mockResolvedValue(undefined);
        mockWriteIdentityGitconfig.mockRejectedValueOnce(new Error('disk full'));
        const warningSpy = jest.spyOn(UIHelper, 'warning');

        await rotateKey();

        expect(warningSpy).toHaveBeenCalledWith(expect.stringContaining('refreshing the rule gitconfig'));
        expect(mockSaveStore).toHaveBeenCalled();
        expect(process.exitCode).toBeUndefined();

        warningSpy.mockRestore();
      });

      it('warns per dead-path binding but keeps the registry entry and still succeeds (needsAttention path surfaces via refreshRegisteredBindings)', async () => {
        const bindings = [{ path: '/repo/gone', identity: 'test-space' }];
        mockLoadStore.mockResolvedValue(storeWith([keyedIdentity], 'test-space', bindings));
        mockConfirm.mockResolvedValue(true);
        mockGenerateKey.mockResolvedValue(newKeyInfo);
        mockAddToAgent.mockResolvedValue(undefined);
        mockRefreshRegisteredBindings.mockResolvedValue({ refreshed: 0, needsAttention: 1 });

        await rotateKey();

        expect(mockRefreshRegisteredBindings).toHaveBeenCalledWith(bindings, expect.anything());
        expect(process.exitCode).toBeUndefined();
        expect(mockSaveStore).toHaveBeenCalled();
      });
    });
  });

  describe('keyCommand dispatch', () => {
    it('fails with exit 1 for an unknown action', async () => {
      mockLoadStore.mockResolvedValue(storeWith([keyedIdentity], 'test-space'));

      await keyCommand('bogus');

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Unknown key action "bogus"'));
      expect(process.exitCode).toBe(1);
      expect(mockLoadStore).not.toHaveBeenCalled();
    });
  });
});
