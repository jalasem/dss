import { slugify, findSpace, findIdentity, validateIdentityName } from '../../src/core/identity';
import { IStoreV2, IConfig } from '../../src/core/types';

describe('spaceLookup', () => {
  describe('findIdentity', () => {
    const store: IStoreV2 = {
      version: 2,
      identities: [
        { name: 'Legacy Name', email: 'legacy@x.com', userName: 'Legacy', host: 'github.com' },
        { name: 'personal', email: 'personal@x.com', userName: 'Personal', host: 'github.com' }
      ],
      bindings: []
    };

    it('finds an identity by an exact name match', () => {
      const identity = findIdentity(store, 'personal');
      expect(identity?.email).toBe('personal@x.com');
    });

    it('finds a legacy raw-name identity when looked up by its slug (slug-aware match)', () => {
      const identity = findIdentity(store, 'legacy-name');
      expect(identity?.name).toBe('Legacy Name');
      expect(identity?.email).toBe('legacy@x.com');
    });

    it('finds an identity when the query itself is unslugified but resolves to the same slug', () => {
      const identity = findIdentity(store, 'Personal');
      expect(identity?.name).toBe('personal');
    });

    it('returns undefined when no identity matches, exactly or by slug', () => {
      expect(findIdentity(store, 'does-not-exist')).toBeUndefined();
    });

    it('returns undefined for an empty store', () => {
      const emptyStore: IStoreV2 = { version: 2, identities: [], bindings: [] };
      expect(findIdentity(emptyStore, 'anything')).toBeUndefined();
    });
  });

  // Pre-existing behavior (findSpace, slugify) — not previously covered by a
  // dedicated unit test file, only exercised indirectly via SpaceManager.
  // Included here for completeness alongside the new findIdentity coverage.
  describe('slugify', () => {
    it('lowercases and hyphenates whitespace-separated words', () => {
      expect(slugify('My Work Space')).toBe('my-work-space');
    });

    it('trims leading/trailing whitespace before slugifying', () => {
      expect(slugify('  Personal  ')).toBe('personal');
    });
  });

  describe('findSpace', () => {
    const config: IConfig = {
      spaces: [
        { name: 'My Work', email: 'work@x.com', userName: 'Work', sshKeyPath: '' },
        { name: 'personal', email: 'personal@x.com', userName: 'Personal', sshKeyPath: '' }
      ]
    };

    it('finds a space by exact name match', () => {
      expect(findSpace(config, 'personal')?.email).toBe('personal@x.com');
    });

    it('finds a legacy raw-name space when looked up by its slug', () => {
      expect(findSpace(config, 'my-work')?.name).toBe('My Work');
    });

    it('returns undefined when no space matches', () => {
      expect(findSpace(config, 'does-not-exist')).toBeUndefined();
    });
  });

  describe('validateIdentityName', () => {
    it('accepts a name with letters, numbers, spaces, hyphens, and underscores', () => {
      expect(validateIdentityName('Work Space_2-Alt')).toBe(true);
    });

    it('rejects an empty or whitespace-only name', () => {
      expect(validateIdentityName('')).not.toBe(true);
      expect(validateIdentityName('   ')).not.toBe(true);
    });

    it('rejects a non-string value', () => {
      expect(validateIdentityName(undefined)).not.toBe(true);
      expect(validateIdentityName(123)).not.toBe(true);
    });

    it('rejects a name shorter than 2 characters', () => {
      expect(validateIdentityName('a')).not.toBe(true);
    });

    it('rejects a path-traversal name', () => {
      expect(validateIdentityName('../../../tmp/evil')).not.toBe(true);
    });

    it('rejects a name containing a slash', () => {
      expect(validateIdentityName('foo/bar')).not.toBe(true);
    });
  });
});
