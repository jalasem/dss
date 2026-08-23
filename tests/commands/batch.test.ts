import os from 'os';
import path from 'path';
import { select, confirm, checkbox } from '@inquirer/prompts';
import { generateKey } from '../../src/infra/keys';
import { UIHelper } from '../../src/commands/ui';
import type { loadStore as LoadStore, saveStore as SaveStore } from '../../src/infra/store';
import type { IIdentity, IKeyInfo, IStoreV2 } from '../../src/core/types';

jest.mock('os');
jest.mock('@inquirer/prompts');
jest.mock('../../src/infra/keys');
jest.mock('../../src/infra/store', () => {
  const actual = jest.requireActual('../../src/infra/store');
  const loadStore = jest.fn();
  const saveStore = jest.fn();
  // Same rebuild-on-top-of-mocks pattern used in tests/commands/spaces.test.ts:
  // loadConfig/persistConfig are defined in the real module in terms of a
  // same-file reference to loadStore/saveStore, which a jest.mock property
  // override can't intercept — rebuild them here so bulkUpdateSpaces still
  // observes the mocked loadStore/saveStore while exercising the real
  // toSpace/mergeIdentity/setIdentityKey logic.
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

// os.homedir mock must be (re)configured before importing spaces/store (whose
// config path constant is computed once, at require time).
const mockOs = os as jest.Mocked<typeof os>;
mockOs.homedir.mockReturnValue('/mock/home');

const { bulkUpdateSpaces } = require('../../src/commands/batch');
const { loadStore, saveStore } = require('../../src/infra/store');

const mockLoadStore = loadStore as jest.MockedFunction<typeof LoadStore>;
const mockSaveStore = saveStore as jest.MockedFunction<typeof SaveStore>;
const mockSelect = select as jest.MockedFunction<typeof select>;
const mockConfirm = confirm as jest.MockedFunction<typeof confirm>;
const mockCheckbox = checkbox as jest.MockedFunction<typeof checkbox>;
const mockGenerateKey = generateKey as jest.MockedFunction<typeof generateKey>;

const mockHomeDir = '/mock/home';

function identity(overrides: Partial<IIdentity> & { name: string }): IIdentity {
  return {
    email: `${overrides.name}@example.com`,
    userName: overrides.name,
    host: 'github.com',
    ...overrides
  };
}

function storeOf(identities: IIdentity[]): IStoreV2 {
  return { version: 2, identities, bindings: [] };
}

describe('commands/batch bulkUpdateSpaces — regenerate-keys', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation();
    mockOs.homedir.mockReturnValue(mockHomeDir);
    mockSelect.mockResolvedValue('regenerate-keys');
    mockConfirm.mockResolvedValue(true);
    mockSaveStore.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  function keyInfoFor(name: string, algorithm: 'ed25519' | 'rsa' = 'ed25519'): IKeyInfo {
    return {
      path: path.join(mockHomeDir, '.dss', 'spaces', name, algorithm === 'rsa' ? 'id_rsa' : 'id_ed25519'),
      algorithm,
      createdAt: '2024-06-01T00:00:00.000Z',
      fingerprint: `SHA256:${name}`
    };
  }

  it('reuses each identity\'s existing algorithm, and defaults to ed25519 for unknown/absent', async () => {
    const rsaIdentity = identity({
      name: 'rsa-space',
      key: { path: '/mock/home/.dss/spaces/rsa-space/id_rsa', algorithm: 'rsa' }
    });
    const ed25519Identity = identity({
      name: 'ed25519-space',
      key: { path: '/mock/home/.dss/spaces/ed25519-space/id_ed25519', algorithm: 'ed25519' }
    });
    const unknownAlgoIdentity = identity({
      name: 'unknown-space',
      key: { path: '/mock/home/.dss/spaces/unknown-space/id_mystery', algorithm: 'unknown' }
    });
    const keylessIdentity = identity({ name: 'keyless-space' });

    mockLoadStore.mockResolvedValue(storeOf([rsaIdentity, ed25519Identity, unknownAlgoIdentity, keylessIdentity]));
    mockCheckbox.mockResolvedValue(['rsa-space', 'ed25519-space', 'unknown-space', 'keyless-space']);
    mockGenerateKey.mockImplementation(async (opts) => keyInfoFor(path.basename(opts.directory), opts.algorithm));

    await bulkUpdateSpaces();

    expect(mockGenerateKey).toHaveBeenCalledWith(expect.objectContaining({ algorithm: 'rsa' }));
    expect(mockGenerateKey).toHaveBeenCalledWith(expect.objectContaining({ algorithm: 'ed25519', comment: ed25519Identity.email }));
    // "unknown" algorithm falls back to ed25519, not carried through as-is
    expect(mockGenerateKey).toHaveBeenCalledWith(expect.objectContaining({
      comment: unknownAlgoIdentity.email,
      algorithm: 'ed25519'
    }));
    // A keyless space also defaults to ed25519
    expect(mockGenerateKey).toHaveBeenCalledWith(expect.objectContaining({
      comment: keylessIdentity.email,
      algorithm: 'ed25519'
    }));
    expect(mockGenerateKey).toHaveBeenCalledTimes(4);
  });

  it('calls setIdentityKey + saveStore with the correct identity name -> IKeyInfo mapping for multiple selections', async () => {
    const spaceA = identity({
      name: 'space-a',
      key: { path: '/mock/home/.dss/spaces/space-a/id_ed25519', algorithm: 'ed25519' }
    });
    const spaceB = identity({
      name: 'space-b',
      key: { path: '/mock/home/.dss/spaces/space-b/id_rsa', algorithm: 'rsa' }
    });

    mockLoadStore.mockResolvedValue(storeOf([spaceA, spaceB]));
    mockCheckbox.mockResolvedValue(['space-a', 'space-b']);

    const keyInfoA = keyInfoFor('space-a', 'ed25519');
    const keyInfoB = keyInfoFor('space-b', 'rsa');
    mockGenerateKey.mockImplementation(async (opts) => {
      const name = path.basename(opts.directory);
      return name === 'space-a' ? keyInfoA : keyInfoB;
    });

    await bulkUpdateSpaces();

    // First save is persistConfig's ISpace-view round trip; the final save
    // (after setIdentityKey) must carry the exact identity-name -> IKeyInfo
    // mapping for every regenerated identity, unmangled.
    const finalStore = mockSaveStore.mock.calls[mockSaveStore.mock.calls.length - 1][0] as IStoreV2;
    const savedA = finalStore.identities.find(i => i.name === 'space-a');
    const savedB = finalStore.identities.find(i => i.name === 'space-b');

    expect(savedA?.key).toEqual(keyInfoA);
    expect(savedB?.key).toEqual(keyInfoB);
    expect(mockSaveStore).toHaveBeenCalledTimes(2);
  });

  it('derives the default ~/.dss/spaces/<slug>/ directory for a keyless space instead of crashing', async () => {
    const keylessIdentity = identity({ name: 'keyless-space' });

    mockLoadStore.mockResolvedValue(storeOf([keylessIdentity]));
    mockCheckbox.mockResolvedValue(['keyless-space']);
    mockGenerateKey.mockResolvedValue(keyInfoFor('keyless-space'));

    await expect(bulkUpdateSpaces()).resolves.toBeUndefined();

    expect(mockGenerateKey).toHaveBeenCalledWith(expect.objectContaining({
      directory: path.join(mockHomeDir, '.dss', 'spaces', 'keyless-space')
    }));

    const finalStore = mockSaveStore.mock.calls[mockSaveStore.mock.calls.length - 1][0] as IStoreV2;
    expect(finalStore.identities.find(i => i.name === 'keyless-space')?.key?.algorithm).toBe('ed25519');
  });

  it('warns for a per-space generateKey failure, continues the loop, and does not persist a stale entry for that space', async () => {
    const okIdentity = identity({
      name: 'ok-space',
      key: { path: '/mock/home/.dss/spaces/ok-space/id_ed25519', algorithm: 'ed25519' }
    });
    const failingIdentity = identity({
      name: 'failing-space',
      key: { path: '/mock/home/.dss/spaces/failing-space/id_ed25519', algorithm: 'ed25519', fingerprint: 'SHA256:original', createdAt: '2023-01-01T00:00:00.000Z' }
    });

    mockLoadStore.mockResolvedValue(storeOf([okIdentity, failingIdentity]));
    mockCheckbox.mockResolvedValue(['ok-space', 'failing-space']);

    const okKeyInfo = keyInfoFor('ok-space');
    mockGenerateKey.mockImplementation(async (opts) => {
      if (opts.comment === failingIdentity.email) {
        throw new Error('ssh-keygen failed');
      }
      return okKeyInfo;
    });

    const errorSpy = jest.spyOn(UIHelper, 'error');

    await bulkUpdateSpaces();

    // The failure is reported but does not abort the loop or the command.
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to regenerate SSH key for failing-space'));
    expect(process.exitCode).toBeUndefined();

    // The successful space is persisted with its new key...
    const finalStore = mockSaveStore.mock.calls[mockSaveStore.mock.calls.length - 1][0] as IStoreV2;
    expect(finalStore.identities.find(i => i.name === 'ok-space')?.key).toEqual(okKeyInfo);

    // ...while the failed space's original key metadata is left untouched —
    // no stale/partial entry was written for it.
    expect(finalStore.identities.find(i => i.name === 'failing-space')?.key).toEqual(failingIdentity.key);

    errorSpy.mockRestore();
  });

  it('does not call persistConfig/saveStore at all when every regeneration in the batch fails', async () => {
    const failingIdentity = identity({ name: 'failing-space' });

    mockLoadStore.mockResolvedValue(storeOf([failingIdentity]));
    mockCheckbox.mockResolvedValue(['failing-space']);
    mockGenerateKey.mockRejectedValue(new Error('ssh-keygen not found'));

    await bulkUpdateSpaces();

    expect(mockSaveStore).not.toHaveBeenCalled();
    const calls = (console.log as jest.Mock).mock.calls.flat();
    expect(calls.some(call => call && call.includes && call.includes('No spaces were updated'))).toBe(true);
  });
});
