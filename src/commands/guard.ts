import { UIHelper } from './ui';
import { fail } from './fail';
import { jsonData } from './jsonOutput';
import { loadStore } from '../infra/store';
import { getEffectiveRepoGitUserEmail } from '../infra/git';
import { resolveAppliesHere, AppliesHereResult } from '../infra/identityResolution';
import {
  HOOK_MARKER,
  resolveHookPath,
  readExistingHook,
  isDssHook,
  writeHook,
  removeHook,
} from '../infra/guard';

/**
 * The wrong-identity guard (Phase 5 · Task 3): an opt-in pre-commit hook
 * that refuses a commit when the effective git identity in the repo
 * doesn't match what DSS expects here (resolveAppliesHere). `install`/
 * `uninstall` manage the hook file itself; `check` is the fast, silent-by-
 * default comparison the hook actually runs on every commit.
 */

async function resolveHookPathOrFail(): Promise<string | undefined> {
  try {
    return await resolveHookPath(process.cwd());
  } catch {
    fail('Not a Git repository (or any of the parent directories).');
    return undefined;
  }
}

/**
 * `dss guard install`: writes the marked pre-commit hook (brief §3) at the
 * worktree-safe, git-resolved hook path. NEVER overwrites a pre-commit hook
 * DSS didn't write — a foreign hook (no `# dss-guard v1` marker) fails with
 * manual-integration instructions instead. Idempotent over a hook DSS DID
 * write: re-running rewrites it silently (no special "already installed"
 * messaging).
 */
export async function installGuard(): Promise<void> {
  const hookPath = await resolveHookPathOrFail();
  if (!hookPath) return;

  const existing = await readExistingHook(hookPath);
  if (existing !== undefined && !isDssHook(existing)) {
    fail(
      `An existing pre-commit hook at ${hookPath} was not written by DSS — refusing to overwrite it. ` +
      `Add this line to it manually instead: dss guard check --quiet || exit 1`
    );
    return;
  }

  await writeHook(hookPath);
  UIHelper.success(`Installed the wrong-identity guard: ${hookPath}`);
  jsonData({ installed: hookPath });
}

/**
 * `dss guard uninstall`: removes the pre-commit hook ONLY when it carries
 * the DSS marker. No hook installed at all is reported as informational
 * (exit 0, `removed: null`), not a failure; a foreign hook fails (exit 1)
 * with the same "not written by DSS" refusal `install` uses.
 */
export async function uninstallGuard(): Promise<void> {
  const hookPath = await resolveHookPathOrFail();
  if (!hookPath) return;

  const existing = await readExistingHook(hookPath);
  if (existing === undefined) {
    UIHelper.info('No pre-commit hook is installed — nothing to remove.');
    jsonData({ removed: null });
    return;
  }
  if (!isDssHook(existing)) {
    fail(`The pre-commit hook at ${hookPath} was not written by DSS (missing "${HOOK_MARKER}") — refusing to remove it.`);
    return;
  }

  await removeHook(hookPath);
  UIHelper.success(`Removed the wrong-identity guard: ${hookPath}`);
  jsonData({ removed: hookPath });
}

interface GuardCheckOptions {
  quiet?: boolean;
}

/**
 * The plan's hard invariant: `dss guard check` (and therefore the installed
 * hook) must NEVER brick a commit for a reason unrelated to an actual
 * identity mismatch. The missing-`dss` case already fails open at the hook
 * level (`command -v dss || exit 0` in infra/guard.ts); this is the same
 * fail-open contract for a PRESENT `dss` whose store/resolution work throws
 * — most reachably a `ConfigVersionError` (loadStore refusing a corrupt or
 * newer-than-this-build config), but also a `resolveAppliesHere`/git call
 * that fails outright. Reports the same `{ok:true, expected:null,
 * effective:null}` shape "no identity applies here" already uses (exit 0,
 * no docsDriftPayloads key-set change) and, since this is genuinely an
 * undetermined/anomalous state rather than routine silence, always prints a
 * one-line note to STDERR (never STDOUT — the `--json` "exactly one object
 * on stdout" contract only governs stdout) so a human running `git commit`
 * sees why the guard didn't check anything, without it being mistaken for
 * the hook's own `--quiet`-suppressed success line.
 */
function allowUndetermined(reason: unknown): void {
  jsonData({ ok: true, expected: null, effective: null });
  const message = reason instanceof Error ? reason.message : String(reason);
  process.stderr.write(`dss guard: could not determine expected identity (${message}); allowing commit\n`);
}

/**
 * `dss guard check`: the fast check the installed hook actually runs on
 * every commit. No identity applies here at all (resolveAppliesHere finds
 * nothing to guard) → exit 0 completely silently, nothing to report.
 * Otherwise compares the expected identity's email against the EFFECTIVE
 * repo-scoped `git config user.email` (respects local config + every
 * include naturally — see infra/git.ts's getEffectiveRepoGitUserEmail).
 * Match → exit 0 (silent under `--quiet`, one ✓ line otherwise). Mismatch
 * → exit 1 with an actionable message; always prints, `--quiet` or not.
 *
 * Loading the store and resolving the identity are wrapped separately (see
 * allowUndetermined above): ONLY a successfully-resolved expected identity
 * whose email disagrees with the effective git config is ever allowed to
 * exit 1. A corrupt/future-version store, a git failure while reading the
 * effective email, or no resolvable identity all fail OPEN at exit 0 —
 * "cannot determine" is never treated as "mismatch".
 *
 * Never prompts (constraint, brief §2/§3) — a hook that could block on
 * stdin mid-`git commit` would be unusable.
 */
export async function checkGuard(options: GuardCheckOptions = {}): Promise<void> {
  let resolved: AppliesHereResult;
  try {
    const store = await loadStore();
    resolved = await resolveAppliesHere(process.cwd(), store);
  } catch (error) {
    allowUndetermined(error);
    return;
  }

  if (!resolved.identity) {
    jsonData({ ok: true, expected: null, effective: null });
    return;
  }

  let effectiveEmail: string | undefined;
  try {
    effectiveEmail = await getEffectiveRepoGitUserEmail(process.cwd());
  } catch (error) {
    allowUndetermined(error);
    return;
  }

  const expected = {
    identity: resolved.identity.name,
    email: resolved.identity.email,
    source: resolved.source,
  };
  const matches = effectiveEmail === resolved.identity.email;

  jsonData({ ok: matches, expected, effective: effectiveEmail ?? null });

  if (matches) {
    if (!options.quiet) {
      UIHelper.success(`Identity check: ${resolved.identity.email} (${resolved.identity.name}, ${resolved.source})`);
    }
    return;
  }

  fail(
    `Wrong identity: expected ${resolved.identity.email} (${resolved.identity.name}, ${resolved.source}) but git will commit as ${effectiveEmail ?? 'unset'} — ` +
    `run "dss use ${resolved.identity.name}" or "dss link ${resolved.identity.name}" to fix it.`
  );
}
