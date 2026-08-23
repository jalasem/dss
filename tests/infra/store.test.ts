import os from 'os';
import fs from 'fs-extra';
import path from 'path';
import type { IIdentity } from '../../src/infra/store';

// eslint-disable-next-line @typescript-eslint/no-var-requires
type StoreModule = typeof import('../../src/infra/store');

describe('infra/store', () => {
  let tempHome: string;
  let store: StoreModule;
  let configPath: string;
  let homedirSpy: jest.SpyInstance;

  beforeAll(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-store-test-'));
    homedirSpy = jest.spyOn(os, 'homedir').mockReturnValue(tempHome);
    // Import after the homedir mock is in place: the module computes its
    // config path constant once, at import time.
    store = require('../../src/infra/store');
    configPath = path.join(tempHome, '.dss', 'spaces', 'config.json');
  });

  afterAll(async () => {
    homedirSpy.mockRestore();
    await fs.remove(tempHome);
  });

  beforeEach(async () => {
    await fs.remove(path.join(tempHome, '.dss'));
  });

  describe('loadStore - v1 migration', () => {
    it('migrates a v1 config into v2 shape, slugifying names and the active space', async () => {
      await fs.outputJson(configPath, {
        spaces: [
          { name: 'My Space', email: 'a@b.com', userName: 'A User', sshKeyPath: '/keys/my-space/id_rsa' }
        ],
        activeSpace: 'My Space'
      });

      const result = await store.loadStore();

      expect(result).toEqual({
        version: 2,
        identities: [
          {
            name: 'my-space',
            email: 'a@b.com',
            userName: 'A User',
            host: 'github.com',
            key: { path: '/keys/my-space/id_rsa', algorithm: 'rsa' }
          }
        ],
        active: 'my-space',
        bindings: []
      });
    });

    it('writes the migrated v2 store back to disk, pretty-printed', async () => {
      await fs.outputJson(configPath, {
        spaces: [{ name: 'solo', email: 'solo@x.com', userName: 'Solo', sshKeyPath: '' }]
      });

      await store.loadStore();

      const raw = await fs.readFile(configPath, 'utf8');
      expect(raw).toContain('\n  "version": 2');
      const onDisk = JSON.parse(raw);
      expect(onDisk.version).toBe(2);
      expect(onDisk.identities).toHaveLength(1);
      expect(onDisk.identities[0].key).toBeUndefined();
    });

    it('handles a keyless v1 space (no key field on the migrated identity)', async () => {
      await fs.outputJson(configPath, {
        spaces: [{ name: 'keyless', email: 'k@x.com', userName: 'K', sshKeyPath: '' }]
      });

      const result = await store.loadStore();

      expect(result.identities[0].key).toBeUndefined();
    });

    it('keeps the first identity on a slug collision and appends -2, -3 to later ones', async () => {
      await fs.outputJson(configPath, {
        spaces: [
          { name: 'Test Space', email: 'first@x.com', userName: 'First', sshKeyPath: '' },
          { name: 'test space', email: 'second@x.com', userName: 'Second', sshKeyPath: '' },
          { name: 'TEST SPACE', email: 'third@x.com', userName: 'Third', sshKeyPath: '' }
        ]
      });

      const result = await store.loadStore();

      expect(result.identities.map((i: IIdentity) => i.name)).toEqual(['test-space', 'test-space-2', 'test-space-3']);
      expect(result.identities.map((i: IIdentity) => i.email)).toEqual(['first@x.com', 'second@x.com', 'third@x.com']);
    });

    it('copies the original v1 file to config.json.v1.bak', async () => {
      const v1Content = {
        spaces: [{ name: 'my-space', email: 'a@b.com', userName: 'A', sshKeyPath: '' }]
      };
      await fs.outputJson(configPath, v1Content);

      await store.loadStore();

      const backupPath = `${configPath}.v1.bak`;
      expect(await fs.pathExists(backupPath)).toBe(true);
      expect(await fs.readJson(backupPath)).toEqual(v1Content);
    });

    it('does not overwrite an existing config.json.v1.bak on a later migration', async () => {
      const backupPath = `${configPath}.v1.bak`;
      await fs.outputJson(backupPath, { sentinel: 'do-not-touch' });
      await fs.outputJson(configPath, {
        spaces: [{ name: 'my-space', email: 'a@b.com', userName: 'A', sshKeyPath: '' }]
      });

      await store.loadStore();

      expect(await fs.readJson(backupPath)).toEqual({ sentinel: 'do-not-touch' });
    });
  });

  describe('loadStore - v2 passthrough', () => {
    it('loads an existing v2 file as-is without creating a v1 backup', async () => {
      const v2Store = {
        version: 2,
        identities: [
          {
            name: 'already-v2',
            email: 'v2@x.com',
            userName: 'V2',
            host: 'github.com',
            key: { path: '/keys/already-v2/id_ed25519', algorithm: 'ed25519' as const }
          }
        ],
        active: 'already-v2',
        bindings: [{ path: '/repo/one', identity: 'already-v2' }]
      };
      await fs.outputJson(configPath, v2Store, { spaces: 2 });

      const result = await store.loadStore();

      expect(result).toEqual(v2Store);
      expect(await fs.pathExists(`${configPath}.v1.bak`)).toBe(false);
    });
  });

  describe('loadStore - corrupt file recovery', () => {
    it('starts fresh and backs up unparseable JSON to config.json.corrupt.bak', async () => {
      await fs.ensureDir(path.dirname(configPath));
      await fs.writeFile(configPath, '{ this is not valid json');

      const result = await store.loadStore();

      expect(result).toEqual({ version: 2, identities: [], bindings: [] });

      const corruptBackupPath = `${configPath}.corrupt.bak`;
      expect(await fs.pathExists(corruptBackupPath)).toBe(true);
      expect(await fs.readFile(corruptBackupPath, 'utf8')).toBe('{ this is not valid json');

      const onDisk = await fs.readJson(configPath);
      expect(onDisk).toEqual({ version: 2, identities: [], bindings: [] });
    });

    it('does not overwrite an existing config.json.corrupt.bak', async () => {
      const corruptBackupPath = `${configPath}.corrupt.bak`;
      await fs.ensureDir(path.dirname(configPath));
      await fs.writeFile(corruptBackupPath, 'sentinel-do-not-touch');
      await fs.writeFile(configPath, '{ also not json');

      await store.loadStore();

      expect(await fs.readFile(corruptBackupPath, 'utf8')).toBe('sentinel-do-not-touch');
    });
  });

  describe('saveStore - atomic write', () => {
    it('writes pretty-printed JSON and cleans up the tmp file', async () => {
      const toSave = {
        version: 2 as const,
        identities: [],
        bindings: [{ path: '/repo/a', identity: 'personal' }]
      };

      await store.saveStore(toSave);

      const tmpPath = `${configPath}.tmp`;
      expect(await fs.pathExists(tmpPath)).toBe(false);
      expect(await fs.pathExists(configPath)).toBe(true);

      const raw = await fs.readFile(configPath, 'utf8');
      expect(raw).toContain('\n  "version": 2');
      expect(JSON.parse(raw)).toEqual(toSave);
    });

    it('overwrites an existing config.json on a subsequent save', async () => {
      await store.saveStore({ version: 2, identities: [], bindings: [] });
      const second = {
        version: 2 as const,
        identities: [{ name: 'a', email: 'a@x.com', userName: 'A', host: 'github.com' }],
        bindings: []
      };

      await store.saveStore(second);

      expect(await fs.readJson(configPath)).toEqual(second);
    });
  });

  describe('recordBinding / removeBinding', () => {
    it('inserts a new binding', () => {
      const s = { version: 2 as const, identities: [], bindings: [] };
      store.recordBinding(s, '/repo/a', 'personal');
      expect(s.bindings).toEqual([{ path: '/repo/a', identity: 'personal' }]);
    });

    it('upserts by canonical path instead of duplicating', () => {
      const s = {
        version: 2 as const,
        identities: [],
        bindings: [{ path: '/repo/a', identity: 'personal' }]
      };
      store.recordBinding(s, '/repo/a', 'work');
      expect(s.bindings).toEqual([{ path: '/repo/a', identity: 'work' }]);
    });

    it('leaves other bindings untouched when upserting one', () => {
      const s = {
        version: 2 as const,
        identities: [],
        bindings: [
          { path: '/repo/a', identity: 'personal' },
          { path: '/repo/b', identity: 'work' }
        ]
      };
      store.recordBinding(s, '/repo/a', 'other');
      expect(s.bindings).toEqual([
        { path: '/repo/a', identity: 'other' },
        { path: '/repo/b', identity: 'work' }
      ]);
    });

    it('removes a binding by path', () => {
      const s = {
        version: 2 as const,
        identities: [],
        bindings: [
          { path: '/repo/a', identity: 'personal' },
          { path: '/repo/b', identity: 'work' }
        ]
      };
      store.removeBinding(s, '/repo/a');
      expect(s.bindings).toEqual([{ path: '/repo/b', identity: 'work' }]);
    });

    it('is a no-op when removing a path that has no binding', () => {
      const s = {
        version: 2 as const,
        identities: [],
        bindings: [{ path: '/repo/a', identity: 'personal' }]
      };
      store.removeBinding(s, '/does/not/exist');
      expect(s.bindings).toEqual([{ path: '/repo/a', identity: 'personal' }]);
    });
  });

  describe('toSpace / fromSpace', () => {
    it('toSpace maps a keyed identity to an ISpace', () => {
      const identity = {
        name: 'personal',
        email: 'p@x.com',
        userName: 'P',
        host: 'github.com',
        key: { path: '/keys/personal/id_ed25519', algorithm: 'ed25519' as const }
      };
      expect(store.toSpace(identity)).toEqual({
        name: 'personal',
        email: 'p@x.com',
        userName: 'P',
        sshKeyPath: '/keys/personal/id_ed25519'
      });
    });

    it('toSpace maps a keyless identity to an empty sshKeyPath', () => {
      const identity = { name: 'keyless', email: 'k@x.com', userName: 'K', host: 'github.com' };
      expect(store.toSpace(identity).sshKeyPath).toBe('');
    });

    it('fromSpace infers ed25519 from an id_ed25519 filename', () => {
      const identity = store.fromSpace({
        name: 'a', email: 'a@x.com', userName: 'A', sshKeyPath: '/keys/a/id_ed25519'
      });
      expect(identity.key).toEqual({ path: '/keys/a/id_ed25519', algorithm: 'ed25519' });
      expect(identity.host).toBe('github.com');
    });

    it('fromSpace infers rsa from an id_rsa filename', () => {
      const identity = store.fromSpace({
        name: 'a', email: 'a@x.com', userName: 'A', sshKeyPath: '/keys/a/id_rsa'
      });
      expect(identity.key?.algorithm).toBe('rsa');
    });

    it('fromSpace falls back to unknown for other filenames', () => {
      const identity = store.fromSpace({
        name: 'a', email: 'a@x.com', userName: 'A', sshKeyPath: '/keys/a/custom_key'
      });
      expect(identity.key?.algorithm).toBe('unknown');
    });

    it('fromSpace leaves key undefined for an empty sshKeyPath', () => {
      const identity = store.fromSpace({ name: 'a', email: 'a@x.com', userName: 'A', sshKeyPath: '' });
      expect(identity.key).toBeUndefined();
    });
  });
});
