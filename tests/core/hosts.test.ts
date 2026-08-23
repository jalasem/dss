import { keySettingsUrl, KNOWN_HOSTS } from '../../src/core/hosts';

describe('core/hosts', () => {
  describe('KNOWN_HOSTS', () => {
    it('lists the three first-class hosts in prompt order', () => {
      expect(KNOWN_HOSTS).toEqual(['github.com', 'gitlab.com', 'bitbucket.org']);
    });
  });

  describe('keySettingsUrl', () => {
    it('maps github.com to its SSH keys settings page', () => {
      expect(keySettingsUrl('github.com')).toBe('https://github.com/settings/keys');
    });

    it('maps gitlab.com to its SSH keys settings page', () => {
      expect(keySettingsUrl('gitlab.com')).toBe('https://gitlab.com/-/user_settings/ssh_keys');
    });

    it('maps bitbucket.org to its SSH keys settings page', () => {
      expect(keySettingsUrl('bitbucket.org')).toBe('https://bitbucket.org/account/settings/ssh-keys/');
    });

    it('returns undefined for an unknown/custom host', () => {
      expect(keySettingsUrl('git.example.com')).toBeUndefined();
    });

    it('returns undefined for an empty string', () => {
      expect(keySettingsUrl('')).toBeUndefined();
    });
  });
});
