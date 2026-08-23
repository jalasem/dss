import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { checkbox, confirm } from '@inquirer/prompts';
import { UIHelper } from '../../src/commands/ui';
import type { loadStore as LoadStore, saveStore as SaveStore, fromSpace as FromSpace } from '../../src/infra/store';
import type { ISpace, IStoreV2 } from '../../src/core/types';

jest.mock('fs-extra');
jest.mock('os');
jest.mock('@inquirer/prompts');
jest.mock('../../src/infra/store', () => {
  const actual = jest.requireActual('../../src/infra/store');
  const loadStore = jest.fn();
  const saveStore = jest.fn();
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

const mockOs = os as jest.Mocked<typeof os>;
mockOs.homedir.mockReturnValue('/mock/home');

const { exportSpaceConfiguration, importSpaceConfiguration } = require('../../src/commands/batch');
const { loadStore, saveStore, fromSpace } = require('../../src/infra/store');

const mockFs = fs as jest.Mocked<typeof fs>;
const mockLoadStore = loadStore as jest.MockedFunction<typeof LoadStore>;
const mockSaveStore = saveStore as jest.MockedFunction<typeof SaveStore>;
const mockCheckbox = checkbox as jest.MockedFunction<typeof checkbox>;
const mockConfirm = confirm as jest.MockedFunction<typeof confirm>;
const typedFromSpace = fromSpace as typeof FromSpace;

const exportPath = path.join('/mock/home', 'dss-export.json');

function storeOf(spaces: ISpace[], active?: string): IStoreV2 {
  return { version: 2, identities: spaces.map(typedFromSpace), active, bindings: [] };
}

describe('commands/batch export/import — host carry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation();
    mockOs.homedir.mockReturnValue('/mock/home');
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  describe('exportSpaceConfiguration', () => {
    it('includes each space\'s host in the exported data, defaulting to github.com when unset', async () => {
      const glSpace: ISpace = { name: 'work', email: 'w@x.com', userName: 'W', host: 'gitlab.com', sshKeyPath: '' };
      const defaultSpace: ISpace = { name: 'personal', email: 'p@x.com', userName: 'P', sshKeyPath: '' };
      mockLoadStore.mockResolvedValue(storeOf([glSpace, defaultSpace]));
      mockCheckbox.mockResolvedValue(['work', 'personal']);
      (mockFs.writeJson as unknown as jest.Mock).mockResolvedValue(undefined);

      await exportSpaceConfiguration();

      expect(mockFs.writeJson).toHaveBeenCalledWith(
        exportPath,
        expect.objectContaining({
          spaces: [
            expect.objectContaining({ name: 'work', host: 'gitlab.com' }),
            expect.objectContaining({ name: 'personal', host: 'github.com' })
          ]
        }),
        expect.anything()
      );
    });

    it('does not export the raw SSH key path', async () => {
      const space: ISpace = { name: 'personal', email: 'p@x.com', userName: 'P', sshKeyPath: '/keys/personal/id_ed25519' };
      mockLoadStore.mockResolvedValue(storeOf([space]));
      mockCheckbox.mockResolvedValue(['personal']);
      (mockFs.writeJson as unknown as jest.Mock).mockResolvedValue(undefined);

      await exportSpaceConfiguration();

      const [, data] = (mockFs.writeJson as unknown as jest.Mock).mock.calls[0];
      expect(data.spaces[0].sshKeyPath).toBeUndefined();
      expect(data.spaces[0].hasSSHKey).toBe(true);
    });
  });

  describe('importSpaceConfiguration', () => {
    it('carries an explicit host from the import file onto the new identity', async () => {
      (mockFs.pathExists as unknown as jest.Mock).mockResolvedValue(true);
      (mockFs.readJson as unknown as jest.Mock).mockResolvedValue({
        spaces: [{ name: 'Imported', email: 'i@x.com', userName: 'I', host: 'bitbucket.org' }]
      });
      mockLoadStore.mockResolvedValue(storeOf([]));
      mockConfirm.mockResolvedValue(true);

      await importSpaceConfiguration();

      expect(mockSaveStore).toHaveBeenCalledWith(expect.objectContaining({
        identities: [expect.objectContaining({ name: 'imported', host: 'bitbucket.org' })]
      }));
    });

    it('defaults to github.com when the import entry has no host field', async () => {
      (mockFs.pathExists as unknown as jest.Mock).mockResolvedValue(true);
      (mockFs.readJson as unknown as jest.Mock).mockResolvedValue({
        spaces: [{ name: 'Legacy', email: 'l@x.com', userName: 'L' }]
      });
      mockLoadStore.mockResolvedValue(storeOf([]));
      mockConfirm.mockResolvedValue(true);

      await importSpaceConfiguration();

      expect(mockSaveStore).toHaveBeenCalledWith(expect.objectContaining({
        identities: [expect.objectContaining({ name: 'legacy', host: 'github.com' })]
      }));
    });

    it('skips spaces that already exist and does not persist when nothing new is imported', async () => {
      (mockFs.pathExists as unknown as jest.Mock).mockResolvedValue(true);
      (mockFs.readJson as unknown as jest.Mock).mockResolvedValue({
        spaces: [{ name: 'personal', email: 'p@x.com', userName: 'P', host: 'gitlab.com' }]
      });
      mockLoadStore.mockResolvedValue(storeOf([{ name: 'personal', email: 'p@x.com', userName: 'P', sshKeyPath: '' }]));

      await importSpaceConfiguration();

      expect(mockSaveStore).not.toHaveBeenCalled();
    });

    it('skips (with a warning naming the entry) an imported identity whose email/userName contains a line break, importing only the clean entries', async () => {
      (mockFs.pathExists as unknown as jest.Mock).mockResolvedValue(true);
      (mockFs.readJson as unknown as jest.Mock).mockResolvedValue({
        spaces: [
          { name: 'Injected', email: 'evil@example.com\n[core]\n\tsshCommand = evil', userName: 'Evil' },
          { name: 'Also Injected', email: 'a@example.com', userName: 'A\rB' },
          { name: 'Clean', email: 'clean@example.com', userName: 'Clean User' }
        ]
      });
      mockLoadStore.mockResolvedValue(storeOf([]));
      mockConfirm.mockResolvedValue(true);

      const warningSpy = jest.spyOn(UIHelper, 'warning');

      await importSpaceConfiguration();

      expect(warningSpy).toHaveBeenCalledWith(expect.stringContaining("Space 'Injected' contains a line break"));
      expect(warningSpy).toHaveBeenCalledWith(expect.stringContaining("Space 'Also Injected' contains a line break"));
      expect(mockSaveStore).toHaveBeenCalledWith(expect.objectContaining({
        identities: [expect.objectContaining({ name: 'clean' })]
      }));

      warningSpy.mockRestore();
    });
  });
});
