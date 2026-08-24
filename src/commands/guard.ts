import { UIHelper } from './ui';
import { fail } from './fail';
import { jsonData } from './jsonOutput';
import { loadStore } from '../infra/store';
import { getEffectiveRepoGitUserEmail } from '../infra/git';
import { resolveAppliesHere } from '../infra/identityResolution';
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
 * `dss guard check`: the fast check the installed hook actually runs on
 * every commit. No identity applies here at all (resolveAppliesHere finds
 * nothing to guard) → exit 0 completely silently, nothing to report.
 * Otherwise compares the expected identity's email against the EFFECTIVE
 * repo-scoped `git config user.email` (respects local config + every
 * include naturally — see infra/git.ts's getEffectiveRepoGitUserEmail).
 * Match → exit 0 (silent under `--quiet`, one ✓ line otherwise). Mismatch
 * → exit 1 with an actionable message; always prints, `--quiet` or not.
 *
 * Never prompts (constraint, brief §2/§3) — a hook that could block on
 * stdin mid-`git commit` would be unusable.
 */
export async function checkGuard(options: GuardCheckOptions = {}): Promise<void> {
  const store = await loadStore();
  const resolved = await resolveAppliesHere(process.cwd(), store);

  if (!resolved.identity) {
    jsonData({ ok: true, expected: null, effective: null });
    return;
  }

  const effectiveEmail = await getEffectiveRepoGitUserEmail(process.cwd());
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
