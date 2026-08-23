// Known Git hosting providers with first-class support in prompts and
// success-message links. Any other hostname is still fully usable (host is
// a free-form field) — it just doesn't get a key-settings deep link.
export const KNOWN_HOSTS = ['github.com', 'gitlab.com', 'bitbucket.org'] as const;

export type KnownHost = typeof KNOWN_HOSTS[number];

/**
 * Maps a Git host to the URL where a user adds/manages SSH public keys for
 * that host. Returns undefined for hosts without a known settings page —
 * callers should fall back to generic "add the public key to your <host>
 * account" guidance in that case.
 */
export function keySettingsUrl(host: string): string | undefined {
  switch (host) {
    case 'github.com':
      return 'https://github.com/settings/keys';
    case 'gitlab.com':
      return 'https://gitlab.com/-/user_settings/ssh_keys';
    case 'bitbucket.org':
      return 'https://bitbucket.org/account/settings/ssh-keys/';
    default:
      return undefined;
  }
}
