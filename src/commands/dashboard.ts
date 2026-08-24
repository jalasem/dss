import fs from 'fs-extra';
import { loadStore } from '../infra/store';
import { getRepositoryBindingStatus, RepositoryBindingStatus } from '../infra/repoBinding';
import { resolveAppliesHere } from '../infra/identityResolution';
import { checkKeyLoadedInAgent } from '../infra/ssh';
import { firstRunFlow } from './firstRun';
import { UIHelper } from './ui';
import { isJsonMode, jsonData } from './jsonOutput';

/**
 * The bare-`dss` front door: which identity applies HERE (bound to this
 * repo, a directory rule matching cwd, or the global default — in that
 * precedence order), and a fast local health summary. Replaces the old
 * no-args `--help` dump.
 *
 * FAST BY DESIGN: no network round-trips. The only exec calls this path
 * makes are `git rev-parse`/`git config` (via getRepositoryBindingStatus)
 * and the cheap `ssh-keygen -lf` + `ssh-add -l` agent check — never
 * `ssh -T`/testHostAccess. `dss doctor` is where the slow, network-backed
 * checks live.
 *
 * `--json` payload shape (stable-keys, Phase 4 · Task 3 principle): every
 * branch below emits all four top-level keys — `identity`, `source`,
 * `health`, `identities` — never a subset. `identity`/`source`/`health`
 * are `null` when there's no resolved identity to report on (empty store,
 * or a non-empty store with nothing active/bound here); `health` is
 * `{ key, agent }` only in the one branch where an identity was actually
 * resolved. Callers can always destructure all four keys without first
 * checking which branch produced the payload.
 */
export async function dashboard(): Promise<void> {
  const store = await loadStore();

  if (store.identities.length === 0) {
    // firstRunFlow's interactive "create your first one now?" offer has no
    // machine-readable shape — skip it entirely in JSON mode and just
    // report the empty state. Stable-keys principle (Phase 4 · Task 3):
    // every dashboard JSON payload emits all four top-level keys
    // (identity, source, health, identities) regardless of branch, so a
    // caller can destructure without checking which branch it landed in —
    // `null` marks "not applicable in this branch" uniformly, rather than
    // omitting the key.
    if (isJsonMode()) {
      jsonData({ identity: null, source: null, health: null, identities: 0 });
      return;
    }
    await firstRunFlow({ spaces: [], activeSpace: store.active });
    return;
  }

  // getRepositoryBindingStatus throws when cwd isn't a Git repo (or on any
  // other lookup failure) — treated as "not bound" so the dashboard never
  // crashes just because it was run outside a repo. Kept as its own call
  // (rather than reusing resolveAppliesHere's internal binding lookup)
  // because the dashboard also needs the raw `bound` flag below for its
  // "this repo uses the global identity" hint, independent of which
  // identity ultimately applies.
  let bindingStatus: RepositoryBindingStatus | undefined;
  try {
    bindingStatus = await getRepositoryBindingStatus(process.cwd());
  } catch {
    bindingStatus = undefined;
  }

  // Precedence — bound > directory rule > global default, matching the real
  // includeIf resolution order — lives in resolveAppliesHere (infra/
  // identityResolution.ts), shared with doctor's commit-history drift check
  // and the `dss guard check` pre-commit guard.
  const resolved = await resolveAppliesHere(process.cwd(), store);
  const identity = resolved.identity ?? undefined;
  const source: 'bound to this repo' | 'directory rule' | 'global default' =
    resolved.source === 'bound' ? 'bound to this repo'
    : resolved.source === 'rule' ? 'directory rule'
    : 'global default';

  if (!identity) {
    UIHelper.warning('No identity is active here.');
    const count = store.identities.length;
    UIHelper.info(
      `${count} identit${count === 1 ? 'y' : 'ies'} available — use ${UIHelper.command('dss use')} to activate one.`
    );
    // Same stable-keys shape as the empty-store branch above — `health:
    // null` here too, since there's no resolved identity to report health
    // for.
    jsonData({ identity: null, source: null, health: null, identities: count });
    return;
  }

  UIHelper.print(
    `${UIHelper.activeSpace(identity.name)}   ${UIHelper.dim(identity.email)} ${UIHelper.dim('· ' + source)}`
  );

  const healthFragments: string[] = [];
  let keyHealth: 'ok' | 'missing' | 'none' = 'none';
  let agentHealth: 'loaded' | 'not-loaded' | 'unknown' = 'unknown';

  if (!identity.key) {
    healthFragments.push(UIHelper.statusFragment('warning', 'no key'));
  } else {
    const keyExists = await fs.pathExists(identity.key.path);
    keyHealth = keyExists ? 'ok' : 'missing';
    healthFragments.push(
      keyExists
        ? UIHelper.statusFragment('success', `key ${identity.key.algorithm}`)
        : UIHelper.statusFragment('error', 'key missing')
    );

    if (keyExists) {
      const agentCheck = await checkKeyLoadedInAgent(`${identity.key.path}.pub`);
      if (!agentCheck.checked) {
        agentHealth = 'unknown';
        healthFragments.push(UIHelper.statusFragment('warning', 'agent unknown'));
      } else {
        agentHealth = agentCheck.loaded ? 'loaded' : 'not-loaded';
        healthFragments.push(
          agentCheck.loaded
            ? UIHelper.statusFragment('success', 'agent loaded')
            : UIHelper.statusFragment('warning', 'agent not loaded')
        );
      }
    }
  }

  UIHelper.print(`  ${healthFragments.join('   ')}`);

  if (!identity.key) {
    UIHelper.print('  ' + UIHelper.dim(`${UIHelper.command(`dss key rotate ${identity.name}`)} to add one`));
  }

  // Only when cwd genuinely IS a git repo (bindingStatus resolved without
  // throwing) and it's simply unbound — not when cwd isn't a repo at all.
  if (source === 'global default' && bindingStatus && !bindingStatus.bound) {
    UIHelper.print(
      '  ' + UIHelper.dim(`· this repo uses the global identity — ${UIHelper.command(`dss link ${identity.name}`)} to bind it`)
    );
  }

  UIHelper.print('');
  const count = store.identities.length;
  UIHelper.print(UIHelper.dim(`${count} identit${count === 1 ? 'y' : 'ies'} · ${UIHelper.command('dss ls')}`));
  UIHelper.print(UIHelper.dim(`${UIHelper.command('dss doctor')} for a full check`));

  jsonData({
    identity: { name: identity.name, email: identity.email, userName: identity.userName, host: identity.host },
    source: resolved.source,
    health: { key: keyHealth, agent: agentHealth },
    identities: count,
  });
}
