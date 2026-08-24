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
});
