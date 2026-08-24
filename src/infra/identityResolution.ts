import fs from 'fs-extra';
import { IIdentity, IStoreV2 } from '../core/types';
import { findIdentity } from '../core/identity';
import { matchRule } from '../core/rules';
import { getRepositoryBindingStatus } from './repoBinding';

export type AppliesHereSource = 'bound' | 'rule' | 'global' | null;

export interface AppliesHereResult {
  identity: IIdentity | null;
  source: AppliesHereSource;
}

/**
 * Resolves "which identity applies HERE, for `cwd`": a repo-local binding
 * (`dss link`) > a matching directory rule (`dss rule add`) > the global
 * active identity (`dss use`) — the same precedence order git's own
 * includeIf resolution follows (repo-local binding is read last by git,
 * rules.gitconfig's includeIf sections next, active.gitconfig's
 * unconditional [user] first/lowest — see infra/git.ts's
 * ensureGlobalInclude for the include-order rationale).
 *
 * Extracted (Phase 5 · Task 3 §0) from the bare-`dss` dashboard's original
 * inline resolution so every caller that needs "which identity is expected
 * HERE" — the dashboard itself, doctor's commit-history drift check, the
 * `dss guard check` pre-commit guard, and (later) `dss prompt` — resolves
 * identity the exact same way, instead of slowly-drifting copies of this
 * precedence.
 *
 * `store` is passed in (not loaded here) so a caller that already has it
 * loaded (every current caller does) doesn't pay for a second read.
 * Never throws: a `cwd` outside any Git repository, or with no realpath
 * (a deleted directory, a dangling symlink), degrades gracefully to the
 * next precedence step rather than failing the whole resolution.
 */
export async function resolveAppliesHere(cwd: string, store: IStoreV2): Promise<AppliesHereResult> {
  let bindingStatus;
  try {
    bindingStatus = await getRepositoryBindingStatus(cwd);
  } catch {
    bindingStatus = undefined;
  }

  if (bindingStatus?.bound && bindingStatus.spaceName) {
    const bound = findIdentity(store, bindingStatus.spaceName);
    if (bound) return { identity: bound, source: 'bound' };
  }

  let canonicalCwd: string | undefined;
  try {
    canonicalCwd = await fs.realpath(cwd);
  } catch {
    canonicalCwd = undefined;
  }
  const rule = canonicalCwd ? matchRule(canonicalCwd, store.rules) : undefined;
  if (rule) {
    const ruled = findIdentity(store, rule.identity);
    if (ruled) return { identity: ruled, source: 'rule' };
  }

  const active = store.active ? findIdentity(store, store.active) : undefined;
  if (active) return { identity: active, source: 'global' };

  return { identity: null, source: null };
}
