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
        bindings: [],
        rules: []
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
        bindings: [{ path: '/repo/one', identity: 'already-v2' }],
        rules: [{ dir: '/code/acme', identity: 'already-v2' }]
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

      expect(result).toEqual({ version: 2, identities: [], bindings: [], rules: [] });

      const corruptBackupPath = `${configPath}.corrupt.bak`;
      expect(await fs.pathExists(corruptBackupPath)).toBe(true);
      expect(await fs.readFile(corruptBackupPath, 'utf8')).toBe('{ this is not valid json');

      const onDisk = await fs.readJson(configPath);
      expect(onDisk).toEqual({ version: 2, identities: [], bindings: [], rules: [] });
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

  describe('loadStore - version gating', () => {
    it('hard-errors on a numeric version newer than this build understands, instead of silently reducing it to an empty store', async () => {
      await fs.outputJson(configPath, {
        version: 3,
        identities: [{ name: 'future', email: 'f@x.com', userName: 'F', host: 'github.com' }],
        bindings: []
      });

      await expect(store.loadStore()).rejects.toThrow(/version 3/);

      // The file itself must be left untouched — no destructive migration.
      const onDisk = await fs.readJson(configPath);
      expect(onDisk.version).toBe(3);
      expect(onDisk.identities).toHaveLength(1);
    });

    it('treats an explicit version === 1 as v1-migratable (same as an absent version)', async () => {
      await fs.outputJson(configPath, {
        version: 1,
        spaces: [{ name: 'explicit-v1', email: 'e@x.com', userName: 'E', sshKeyPath: '' }]
      });

      const result = await store.loadStore();

      expect(result.version).toBe(2);
      expect(result.identities).toEqual([
        { name: 'explicit-v1', email: 'e@x.com', userName: 'E', host: 'github.com' }
      ]);
    });
  });

  describe('saveStore - atomic write', () => {
    it('writes pretty-printed JSON and cleans up the tmp file', async () => {
      const toSave = {
        version: 2 as const,
        identities: [],
        bindings: [{ path: '/repo/a', identity: 'personal' }],
        rules: [{ dir: '/code/acme', identity: 'personal' }]
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
      await store.saveStore({ version: 2, identities: [], bindings: [], rules: [] });
      const second = {
        version: 2 as const,
        identities: [{ name: 'a', email: 'a@x.com', userName: 'A', host: 'github.com' }],
        bindings: [],
        rules: []
      };

      await store.saveStore(second);

      expect(await fs.readJson(configPath)).toEqual(second);
    });
  });

  describe('recordBinding / removeBinding', () => {
    it('inserts a new binding', () => {
      const s = { version: 2 as const, identities: [], bindings: [], rules: [] };
      store.recordBinding(s, '/repo/a', 'personal');
      expect(s.bindings).toEqual([{ path: '/repo/a', identity: 'personal' }]);
    });

    it('upserts by canonical path instead of duplicating', () => {
      const s = {
        version: 2 as const,
        identities: [],
        bindings: [{ path: '/repo/a', identity: 'personal' }],
        rules: []
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
        ],
        rules: []
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
        ],
        rules: []
      };
      store.removeBinding(s, '/repo/a');
      expect(s.bindings).toEqual([{ path: '/repo/b', identity: 'work' }]);
    });

    it('is a no-op when removing a path that has no binding', () => {
      const s = {
        version: 2 as const,
        identities: [],
        bindings: [{ path: '/repo/a', identity: 'personal' }],
        rules: []
      };
      store.removeBinding(s, '/does/not/exist');
      expect(s.bindings).toEqual([{ path: '/repo/a', identity: 'personal' }]);
    });
  });

  describe('upsertRule / removeRule', () => {
    it('inserts a new rule', () => {
      const s = { version: 2 as const, identities: [], bindings: [], rules: [] };
      store.upsertRule(s, '/code/acme', 'work');
      expect(s.rules).toEqual([{ dir: '/code/acme', identity: 'work' }]);
    });

    it('upserts by canonical dir instead of duplicating', () => {
      const s = {
        version: 2 as const,
        identities: [],
        bindings: [],
        rules: [{ dir: '/code/acme', identity: 'work' }]
      };
      store.upsertRule(s, '/code/acme', 'other');
      expect(s.rules).toEqual([{ dir: '/code/acme', identity: 'other' }]);
    });

    it('leaves other rules untouched when upserting one', () => {
      const s = {
        version: 2 as const,
        identities: [],
        bindings: [],
        rules: [
          { dir: '/code/acme', identity: 'work' },
          { dir: '/code/personal', identity: 'personal' }
        ]
      };
      store.upsertRule(s, '/code/acme', 'other');
      expect(s.rules).toEqual([
        { dir: '/code/acme', identity: 'other' },
        { dir: '/code/personal', identity: 'personal' }
      ]);
    });

    it('removes a rule by dir and reports it was removed', () => {
      const s = {
        version: 2 as const,
        identities: [],
        bindings: [],
        rules: [
          { dir: '/code/acme', identity: 'work' },
          { dir: '/code/personal', identity: 'personal' }
        ]
      };
      const removed = store.removeRule(s, '/code/acme');
      expect(removed).toBe(true);
      expect(s.rules).toEqual([{ dir: '/code/personal', identity: 'personal' }]);
    });

    it('is a no-op and reports false when removing a dir that has no rule', () => {
      const s = {
        version: 2 as const,
        identities: [],
        bindings: [],
        rules: [{ dir: '/code/acme', identity: 'work' }]
      };
      const removed = store.removeRule(s, '/does/not/exist');
      expect(removed).toBe(false);
      expect(s.rules).toEqual([{ dir: '/code/acme', identity: 'work' }]);
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
        sshKeyPath: '/keys/personal/id_ed25519',
        host: 'github.com'
      });
    });

    it('toSpace maps a keyless identity to an empty sshKeyPath', () => {
      const identity = { name: 'keyless', email: 'k@x.com', userName: 'K', host: 'github.com' };
      expect(store.toSpace(identity).sshKeyPath).toBe('');
    });

    it('toSpace carries a non-default host through', () => {
      const identity = { name: 'work', email: 'w@x.com', userName: 'W', host: 'gitlab.com' };
      expect(store.toSpace(identity).host).toBe('gitlab.com');
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

    it('fromSpace carries an explicit space.host through instead of defaulting', () => {
      const identity = store.fromSpace({
        name: 'a', email: 'a@x.com', userName: 'A', sshKeyPath: '', host: 'bitbucket.org'
      });
      expect(identity.host).toBe('bitbucket.org');
    });
  });

  describe('mergeIdentity', () => {
    it('returns a plain fromSpace result when there is no original identity (brand-new space)', () => {
      const space = { name: 'a', email: 'a@x.com', userName: 'A', sshKeyPath: '/keys/a/id_rsa' };
      expect(store.mergeIdentity(space, undefined)).toEqual(store.fromSpace(space));
    });

    it('preserves the original host instead of resetting to the fromSpace default', () => {
      const original: IIdentity = {
        name: 'a', email: 'old@x.com', userName: 'Old', host: 'gitlab.com'
      };
      const space = { name: 'a', email: 'new@x.com', userName: 'New', sshKeyPath: '' };

      const merged = store.mergeIdentity(space, original);

      expect(merged.host).toBe('gitlab.com');
      expect(merged.email).toBe('new@x.com');
      expect(merged.userName).toBe('New');
    });

    it('uses the edited space\'s explicit host instead of the original when both are present', () => {
      const original: IIdentity = {
        name: 'a', email: 'a@x.com', userName: 'A', host: 'github.com'
      };
      const space = { name: 'a', email: 'a@x.com', userName: 'A', sshKeyPath: '', host: 'gitlab.com' };

      const merged = store.mergeIdentity(space, original);

      expect(merged.host).toBe('gitlab.com');
    });

    it('preserves key fingerprint and createdAt when the key path is unchanged', () => {
      const original: IIdentity = {
        name: 'a',
        email: 'a@x.com',
        userName: 'A',
        host: 'github.com',
        key: {
          path: '/keys/a/id_ed25519',
          algorithm: 'ed25519',
          fingerprint: 'SHA256:deadbeef',
          createdAt: '2024-01-01T00:00:00.000Z'
        }
      };
      const space = { name: 'a', email: 'a2@x.com', userName: 'A2', sshKeyPath: '/keys/a/id_ed25519' };

      const merged = store.mergeIdentity(space, original);

      expect(merged.key).toEqual(original.key);
    });

    it('preserves fingerprint/createdAt but recomputes algorithm when the key path changes', () => {
      const original: IIdentity = {
        name: 'a',
        email: 'a@x.com',
        userName: 'A',
        host: 'github.com',
        key: {
          path: '/keys/a/id_rsa',
          algorithm: 'rsa',
          fingerprint: 'SHA256:deadbeef',
          createdAt: '2024-01-01T00:00:00.000Z'
        }
      };
      // Same identity, key relocated (e.g. a rename) to a differently-named file.
      const space = { name: 'a', email: 'a@x.com', userName: 'A', sshKeyPath: '/keys/a-new/id_ed25519' };

      const merged = store.mergeIdentity(space, original);

      expect(merged.key?.path).toBe('/keys/a-new/id_ed25519');
      expect(merged.key?.algorithm).toBe('ed25519');
      expect(merged.key?.fingerprint).toBe('SHA256:deadbeef');
      expect(merged.key?.createdAt).toBe('2024-01-01T00:00:00.000Z');
    });

    it('drops key metadata when the edited space becomes keyless', () => {
      const original: IIdentity = {
        name: 'a',
        email: 'a@x.com',
        userName: 'A',
        host: 'github.com',
        key: { path: '/keys/a/id_rsa', algorithm: 'rsa', fingerprint: 'SHA256:deadbeef' }
      };
      const space = { name: 'a', email: 'a@x.com', userName: 'A', sshKeyPath: '' };

      const merged = store.mergeIdentity(space, original);

      expect(merged.key).toBeUndefined();
    });

    it('sets fresh key metadata (no fingerprint/createdAt) when a previously-keyless space gains a key', () => {
      const original: IIdentity = { name: 'a', email: 'a@x.com', userName: 'A', host: 'github.com' };
      const space = { name: 'a', email: 'a@x.com', userName: 'A', sshKeyPath: '/keys/a/id_rsa' };

      const merged = store.mergeIdentity(space, original);

      expect(merged.key).toEqual({ path: '/keys/a/id_rsa', algorithm: 'rsa' });
    });

    it('preserves the original algorithm on a directory-only move (same basename), even for a non-standard filename that would otherwise re-infer to "unknown"', () => {
      // Regression: a rename that only moves the key DIRECTORY (basename
      // unchanged) used to re-infer the algorithm from the filename any
      // time the path changed at all — silently flipping a correctly known
      // algorithm (e.g. 'ed25519' on a legacy non-standard filename like
      // "id_mystery") to 'unknown' on every such rename.
      const original: IIdentity = {
        name: 'a',
        email: 'a@x.com',
        userName: 'A',
        host: 'github.com',
        key: {
          path: '/keys/a/id_mystery',
          algorithm: 'ed25519',
          fingerprint: 'SHA256:deadbeef',
          createdAt: '2024-01-01T00:00:00.000Z'
        }
      };
      const space = { name: 'a', email: 'a@x.com', userName: 'A', sshKeyPath: '/keys/a-renamed/id_mystery' };

      const merged = store.mergeIdentity(space, original);

      expect(merged.key?.path).toBe('/keys/a-renamed/id_mystery');
      expect(merged.key?.algorithm).toBe('ed25519');
      expect(merged.key?.fingerprint).toBe('SHA256:deadbeef');
    });
  });
});
