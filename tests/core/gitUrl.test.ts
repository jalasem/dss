import { parseGitUrl } from '../../src/core/gitUrl';

describe('core/gitUrl — parseGitUrl (pure)', () => {
  describe('scp-like ssh (git@host:org/repo.git)', () => {
    it('parses a standard GitHub-style scp URL', () => {
      expect(parseGitUrl('git@github.com:acme/api.git')).toEqual({
        host: 'github.com',
        repoName: 'api',
        isSsh: true
      });
    });

    it('parses without a trailing .git', () => {
      expect(parseGitUrl('git@github.com:acme/api')).toEqual({
        host: 'github.com',
        repoName: 'api',
        isSsh: true
      });
    });

    it('parses a custom user and a single-segment path', () => {
      expect(parseGitUrl('deploy@git.example.com:repo.git')).toEqual({
        host: 'git.example.com',
        repoName: 'repo',
        isSsh: true
      });
    });
  });

  describe('ssh:// URLs', () => {
    it('parses ssh:// without a port', () => {
      expect(parseGitUrl('ssh://git@github.com/acme/api.git')).toEqual({
        host: 'github.com',
        repoName: 'api',
        isSsh: true
      });
    });

    it('parses ssh:// with a port', () => {
      expect(parseGitUrl('ssh://git@example.com:2222/acme/api.git')).toEqual({
        host: 'example.com',
        repoName: 'api',
        isSsh: true
      });
    });
  });

  describe('https:// / http:// URLs', () => {
    it('parses https:// with a trailing .git', () => {
      expect(parseGitUrl('https://github.com/acme/api.git')).toEqual({
        host: 'github.com',
        repoName: 'api',
        isSsh: false
      });
    });

    it('parses https:// without a trailing .git', () => {
      expect(parseGitUrl('https://github.com/acme/api')).toEqual({
        host: 'github.com',
        repoName: 'api',
        isSsh: false
      });
    });

    it('parses plain http://', () => {
      expect(parseGitUrl('http://internal.example.com/team/tool.git')).toEqual({
        host: 'internal.example.com',
        repoName: 'tool',
        isSsh: false
      });
    });
  });

  describe('git:// URLs', () => {
    it('parses git://', () => {
      expect(parseGitUrl('git://github.com/acme/api.git')).toEqual({
        host: 'github.com',
        repoName: 'api',
        isSsh: false
      });
    });
  });

  describe('local paths (host undefined — skips host-match)', () => {
    it('parses a file:// URL', () => {
      expect(parseGitUrl('file:///tmp/fixtures/source.git')).toEqual({
        host: undefined,
        repoName: 'source',
        isSsh: false
      });
    });

    it('parses a plain absolute path', () => {
      expect(parseGitUrl('/tmp/fixtures/source.git')).toEqual({
        host: undefined,
        repoName: 'source',
        isSsh: false
      });
    });

    it('parses a relative ./ path', () => {
      expect(parseGitUrl('./fixtures/source.git')).toEqual({
        host: undefined,
        repoName: 'source',
        isSsh: false
      });
    });

    it('parses a relative ../ path', () => {
      expect(parseGitUrl('../fixtures/source.git')).toEqual({
        host: undefined,
        repoName: 'source',
        isSsh: false
      });
    });

    it('parses a home-relative ~/ path', () => {
      expect(parseGitUrl('~/fixtures/source.git')).toEqual({
        host: undefined,
        repoName: 'source',
        isSsh: false
      });
    });

    it('strips a trailing slash before taking the basename', () => {
      expect(parseGitUrl('/tmp/fixtures/source.git/')).toEqual({
        host: undefined,
        repoName: 'source',
        isSsh: false
      });
    });
  });

  describe('unparseable input', () => {
    it('returns undefined for an empty string', () => {
      expect(parseGitUrl('')).toBeUndefined();
      expect(parseGitUrl('   ')).toBeUndefined();
    });

    it('returns undefined for a bare token with no separator (not a path, not scp-like)', () => {
      expect(parseGitUrl('nonsense')).toBeUndefined();
    });

    it('returns undefined for an unrecognized scheme', () => {
      expect(parseGitUrl('ftp://example.com/repo.git')).toBeUndefined();
    });

    it('returns undefined for input containing whitespace', () => {
      expect(parseGitUrl('not a url at all')).toBeUndefined();
    });

    it('returns undefined for a scheme URL with an empty path', () => {
      expect(parseGitUrl('https://github.com/')).toBeUndefined();
      expect(parseGitUrl('https://github.com')).toBeUndefined();
    });
  });

  // Security (argument injection / argv flag smuggling): a url starting
  // with `-` must never parse successfully — it would otherwise reach
  // execFile('git', ['clone', '--', url, dest], ...) and, without this
  // rejection, could be crafted to look like a git flag (e.g.
  // `--upload-pack=<cmd>`, a remote-code-execution vector). This is the
  // PRIMARY defense; infra/gitClone.ts's `--` end-of-options separator is
  // the second, defense-in-depth layer.
  describe('argument-injection guard: a leading "-" is always unparseable', () => {
    it('rejects a bare leading-dash token', () => {
      expect(parseGitUrl('-anything')).toBeUndefined();
    });

    it('rejects a git-flag-shaped string outright', () => {
      expect(parseGitUrl('--upload-pack=touch /tmp/pwned')).toBeUndefined();
      expect(parseGitUrl('--upload-pack=/tmp/x')).toBeUndefined();
      expect(parseGitUrl('-oProxyCommand=touch /tmp/pwned')).toBeUndefined();
    });

    it('rejects even when the rest of the string looks like a valid form', () => {
      expect(parseGitUrl('-ssh://git@github.com/acme/api.git')).toBeUndefined();
      expect(parseGitUrl('-/tmp/fixtures/source.git')).toBeUndefined();
    });
  });
});
