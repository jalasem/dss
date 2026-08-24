import path from 'path';
import { URL } from 'url';

/** Parsed shape of a Git remote URL, as needed by `dss clone`'s identity
 * selection (host-match step) and destination naming. */
export interface ParsedGitUrl {
  /** The remote's hostname — `undefined` for a local filesystem path (a
   * `file://` URL or a bare/relative/absolute path), which skips the
   * host-match selection step entirely (there's no host to match against). */
  host: string | undefined;
  /** `basename(path)` with a trailing `.git` stripped. */
  repoName: string;
  /** True for scp-like ssh (`git@host:org/repo.git`) or `ssh://` URLs — the
   * two forms that can be cloned with a keyed `GIT_SSH_COMMAND`. False for
   * https/http, `git://`, and local filesystem paths, which never need one. */
  isSsh: boolean;
}

const URL_SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//;
const RECOGNIZED_SCHEMES = new Set(['ssh', 'https', 'http', 'git', 'file']);

// scp-like syntax: `[user@]host:path` — no `://` anywhere, a host made only
// of alphanumerics/dots/hyphens (never a `/`, which is what tells this apart
// from an absolute local path), then a colon, then anything as the path.
const SCP_LIKE = /^(?:[^@\s/]+@)?([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?):(.+)$/;

/** `basename(pathPart)` with a trailing `.git` stripped, or `undefined` for
 * an empty/root path with nothing usable as a repo name. */
function repoNameFromPath(pathPart: string): string | undefined {
  const cleaned = pathPart.replace(/\/+$/, '');
  const base = path.basename(cleaned);
  if (!base) return undefined;
  return base.endsWith('.git') ? base.slice(0, -4) : base;
}

/**
 * Parses a Git remote URL into `{ host, repoName, isSsh }`, or `undefined`
 * when it's not recognized as any supported form — the caller (`dss clone`)
 * turns that into a `UsageError` ("unrecognized Git URL"), exit 2.
 *
 * Supported forms:
 * - scp-like ssh: `git@host:org/repo.git`
 * - `ssh://git@host[:port]/org/repo.git`
 * - `https://host/org/repo[.git]` (and plain `http://`)
 * - `git://host/...`
 * - a local filesystem path (`file://...`, or a bare absolute/relative/`~`
 *   path) — `host` comes back `undefined`, which skips the clone command's
 *   host-match selection step; added specifically so the docs-drift payload
 *   test (and anyone else) can drive `dss clone` against a local bare repo
 *   fixture without ever touching the network.
 */
export function parseGitUrl(rawUrl: string): ParsedGitUrl | undefined {
  const url = rawUrl.trim();
  if (!url || /\s/.test(url)) return undefined;

  // Defense in depth against argument injection (argv flag smuggling): a
  // string starting with `-` would otherwise be handed straight to
  // `execFile('git', ['clone', url, dest], ...)` and parsed by git as a
  // FLAG rather than a positional URL (e.g. `--upload-pack=<cmd>` is a
  // remote-code-execution vector). Rejecting it here — before it ever
  // reaches any git subprocess, present or future — is the primary defense;
  // infra/gitClone.ts's `--` end-of-options separator is the second layer.
  if (url.startsWith('-')) return undefined;

  const schemeMatch = URL_SCHEME.exec(url);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (!RECOGNIZED_SCHEMES.has(scheme)) return undefined;

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return undefined;
    }

    const repoName = repoNameFromPath(parsed.pathname);
    if (!repoName) return undefined;

    if (scheme === 'file') {
      return { host: undefined, repoName, isSsh: false };
    }
    if (!parsed.hostname) return undefined;
    return { host: parsed.hostname, repoName, isSsh: scheme === 'ssh' };
  }

  const scpMatch = SCP_LIKE.exec(url);
  if (scpMatch) {
    const [, host, pathPart] = scpMatch;
    const repoName = repoNameFromPath(pathPart);
    if (repoName) return { host, repoName, isSsh: true };
    return undefined;
  }

  // Local filesystem path fallback: absolute, relative (./ or ../), or
  // home-relative (~/) — anything containing a path separator, since a
  // scp-like host:path (handled above) and a scheme URL (handled above)
  // have already been ruled out by this point. A bare single token with no
  // separator (e.g. "nonsense") is deliberately left unparseable rather than
  // guessed at as a relative path.
  if (url.startsWith('/') || url.startsWith('./') || url.startsWith('../') || url.startsWith('~/') || url.includes('/')) {
    const repoName = repoNameFromPath(url);
    return repoName ? { host: undefined, repoName, isSsh: false } : undefined;
  }

  return undefined;
}
