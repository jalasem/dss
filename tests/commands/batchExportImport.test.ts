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
// Defensive-only (Phase-2 final review flag): export/import don't currently
// call switchSpace/git at all, so this file was "safe by accident" rather
// than by isolation. Mock the infra modules a git-touching path would go
// through so a future test added to this file that DOES exercise one can't
// mutate the real environment (~/.gitconfig, ssh-agent, ...) — mirrors the
// isolation every other command test file (e.g. spaces.test.ts) already has.
jest.mock('../../src/infra/git');
jest.mock('../../src/infra/ssh');
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
  return { version: 2, identities: spaces.map(typedFromSpace), active, bindings: [], rules: [] };
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
    // Fix-report follow-up (Important #1): the identity checkbox now goes
    // through guardedCheckbox — non-interactive mode exports ALL identities
    // instead of hanging on the selection prompt (controller ruling).
    it('non-interactive: exports ALL identities with no checkbox prompt (never hangs on stdin)', async () => {
      const original = process.stdin.isTTY;
      (process.stdin as any).isTTY = false;
      try {
        const glSpace: ISpace = { name: 'work', email: 'w@x.com', userName: 'W', host: 'gitlab.com', sshKeyPath: '' };
        const defaultSpace: ISpace = { name: 'personal', email: 'p@x.com', userName: 'P', sshKeyPath: '' };
        mockLoadStore.mockResolvedValue(storeOf([glSpace, defaultSpace]));
        (mockFs.writeJson as unknown as jest.Mock).mockResolvedValue(undefined);

        await exportSpaceConfiguration();

        expect(mockCheckbox).not.toHaveBeenCalled();
        expect(mockFs.writeJson).toHaveBeenCalledWith(
          exportPath,
          expect.objectContaining({
            spaces: [
              expect.objectContaining({ name: 'work' }),
              expect.objectContaining({ name: 'personal' })
            ]
          }),
          expect.anything()
        );
      } finally {
        (process.stdin as any).isTTY = original;
      }
    });

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

    // `dss config export [path]`: an optional path argument overrides the
    // default `~/dss-export.json`, reached both via the new `config export`
    // grouping and the legacy top-level `export` alias (same handler).
    it('writes to a caller-supplied path instead of the default ~/dss-export.json when one is given', async () => {
      const space: ISpace = { name: 'personal', email: 'p@x.com', userName: 'P', sshKeyPath: '' };
      mockLoadStore.mockResolvedValue(storeOf([space]));
      mockCheckbox.mockResolvedValue(['personal']);
      (mockFs.writeJson as unknown as jest.Mock).mockResolvedValue(undefined);

      await exportSpaceConfiguration('/custom/export-location.json');

      expect(mockFs.writeJson).toHaveBeenCalledWith(
        '/custom/export-location.json',
        expect.anything(),
        expect.anything()
      );
    });

    it('still defaults to ~/dss-export.json when no path argument is given', async () => {
      const space: ISpace = { name: 'personal', email: 'p@x.com', userName: 'P', sshKeyPath: '' };
      mockLoadStore.mockResolvedValue(storeOf([space]));
      mockCheckbox.mockResolvedValue(['personal']);
      (mockFs.writeJson as unknown as jest.Mock).mockResolvedValue(undefined);

      await exportSpaceConfiguration();

      expect(mockFs.writeJson).toHaveBeenCalledWith(exportPath, expect.anything(), expect.anything());
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

      expect(warningSpy).toHaveBeenCalledWith(expect.stringContaining("Identity 'Injected' contains a line break"));
      expect(warningSpy).toHaveBeenCalledWith(expect.stringContaining("Identity 'Also Injected' contains a line break"));
      expect(mockSaveStore).toHaveBeenCalledWith(expect.objectContaining({
        identities: [expect.objectContaining({ name: 'clean' })]
      }));

      warningSpy.mockRestore();
    });

    // Security regression (Critical finding): `host` reaches applyHostSSHKey
    // (the ssh-config writer) unvalidated once a key is later given to this
    // identity and it's switched to — a crafted host line break there is an
    // arbitrary ssh_config directive injection (e.g. ProxyCommand), an RCE
    // vector on the next SSH invocation. The import layer must reject it too,
    // as defense-in-depth alongside the writer's own hard gate.
    it('skips (with a warning naming the entry) an imported identity whose host contains a line break, importing only the clean entries', async () => {
      (mockFs.pathExists as unknown as jest.Mock).mockResolvedValue(true);
      (mockFs.readJson as unknown as jest.Mock).mockResolvedValue({
        spaces: [
          { name: 'Poisoned', email: 'p@example.com', userName: 'P', host: 'github.com\n  ProxyCommand /bin/sh -c "evil"' },
          { name: 'Clean', email: 'clean@example.com', userName: 'Clean User', host: 'github.com' }
        ]
      });
      mockLoadStore.mockResolvedValue(storeOf([]));
      mockConfirm.mockResolvedValue(true);

      const warningSpy = jest.spyOn(UIHelper, 'warning');

      await importSpaceConfiguration();

      expect(warningSpy).toHaveBeenCalledWith(expect.stringContaining("Identity 'Poisoned' contains a line break"));
      expect(mockSaveStore).toHaveBeenCalledWith(expect.objectContaining({
        identities: [expect.objectContaining({ name: 'clean' })]
      }));

      warningSpy.mockRestore();
    });

    // Path-traversal name (finding #8): the imported name becomes an fs path
    // segment (key directory) once a key is generated for it.
    it('skips (with a warning naming the entry) an imported identity whose name is a path-traversal attempt, importing only the clean entries', async () => {
      (mockFs.pathExists as unknown as jest.Mock).mockResolvedValue(true);
      (mockFs.readJson as unknown as jest.Mock).mockResolvedValue({
        spaces: [
          { name: '../../../tmp/evil', email: 'p@example.com', userName: 'P' },
          { name: 'Clean', email: 'clean@example.com', userName: 'Clean User' }
        ]
      });
      mockLoadStore.mockResolvedValue(storeOf([]));
      mockConfirm.mockResolvedValue(true);

      const warningSpy = jest.spyOn(UIHelper, 'warning');

      await importSpaceConfiguration();

      expect(warningSpy).toHaveBeenCalledWith(expect.stringContaining("Identity '../../../tmp/evil' has an invalid name"));
      expect(mockSaveStore).toHaveBeenCalledWith(expect.objectContaining({
        identities: [expect.objectContaining({ name: 'clean' })]
      }));

      warningSpy.mockRestore();
    });

    // `dss config import [path]`: an optional path argument overrides the
    // default `~/dss-export.json`, reached both via the new `config import`
    // grouping and the legacy top-level `import` alias (same handler).
    it('reads from a caller-supplied path instead of the default ~/dss-export.json when one is given', async () => {
      (mockFs.pathExists as unknown as jest.Mock).mockResolvedValue(true);
      (mockFs.readJson as unknown as jest.Mock).mockResolvedValue({
        spaces: [{ name: 'fromcustom', email: 'c@x.com', userName: 'C' }]
      });
      mockLoadStore.mockResolvedValue(storeOf([]));
      mockConfirm.mockResolvedValue(true);

      await importSpaceConfiguration('/custom/export-location.json');

      expect(mockFs.pathExists).toHaveBeenCalledWith('/custom/export-location.json');
      expect(mockFs.readJson).toHaveBeenCalledWith('/custom/export-location.json');
    });

    it('still defaults to ~/dss-export.json when no path argument is given', async () => {
      (mockFs.pathExists as unknown as jest.Mock).mockResolvedValue(false);

      await importSpaceConfiguration();

      expect(mockFs.pathExists).toHaveBeenCalledWith(exportPath);
    });
  });
});
