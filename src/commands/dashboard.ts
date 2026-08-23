import fs from 'fs-extra';
import { loadStore } from '../infra/store';
import { findIdentity } from '../core/identity';
import { getRepositoryBindingStatus, RepositoryBindingStatus } from '../infra/repoBinding';
import { checkKeyLoadedInAgent } from '../infra/ssh';
import { firstRunFlow } from './firstRun';
import { UIHelper } from './ui';

/**
 * The bare-`dss` front door: which identity applies HERE (bound to this
 * repo, or the global default), and a fast local health summary. Replaces
 * the old no-args `--help` dump.
 *
 * FAST BY DESIGN: no network round-trips. The only exec calls this path
 * makes are `git rev-parse`/`git config` (via getRepositoryBindingStatus)
 * and the cheap `ssh-keygen -lf` + `ssh-add -l` agent check — never
 * `ssh -T`/testHostAccess. `dss doctor` is where the slow, network-backed
 * checks live.
 */
export async function dashboard(): Promise<void> {
  const store = await loadStore();

  if (store.identities.length === 0) {
    await firstRunFlow({ spaces: [], activeSpace: store.active });
    return;
  }

  // getRepositoryBindingStatus throws when cwd isn't a Git repo (or on any
  // other lookup failure) — treated as "not bound" so the dashboard never
  // crashes just because it was run outside a repo.
  let bindingStatus: RepositoryBindingStatus | undefined;
  try {
    bindingStatus = await getRepositoryBindingStatus(process.cwd());
  } catch {
    bindingStatus = undefined;
  }

  let identity = bindingStatus?.bound && bindingStatus.spaceName
    ? findIdentity(store, bindingStatus.spaceName)
    : undefined;
  let source = 'bound to this repo';

  if (!identity) {
    identity = store.active ? findIdentity(store, store.active) : undefined;
    source = 'global default';
  }

  if (!identity) {
    UIHelper.warning('No identity is active here.');
    const count = store.identities.length;
    UIHelper.info(
      `${count} identit${count === 1 ? 'y' : 'ies'} available — use ${UIHelper.command('dss use')} to activate one.`
    );
    return;
  }

  console.log(
    `${UIHelper.activeSpace(identity.name)}   ${UIHelper.dim(identity.email)} ${UIHelper.dim('· ' + source)}`
  );

  const healthFragments: string[] = [];

  if (!identity.key) {
    healthFragments.push(UIHelper.statusFragment('warning', 'no key'));
  } else {
    const keyExists = await fs.pathExists(identity.key.path);
    healthFragments.push(
      keyExists
        ? UIHelper.statusFragment('success', `key ${identity.key.algorithm}`)
        : UIHelper.statusFragment('error', 'key missing')
    );

    if (keyExists) {
      const agentCheck = await checkKeyLoadedInAgent(`${identity.key.path}.pub`);
      if (!agentCheck.checked) {
        healthFragments.push(UIHelper.statusFragment('warning', 'agent unknown'));
      } else {
        healthFragments.push(
          agentCheck.loaded
            ? UIHelper.statusFragment('success', 'agent loaded')
            : UIHelper.statusFragment('warning', 'agent not loaded')
        );
      }
    }
  }

  console.log(`  ${healthFragments.join('   ')}`);

  if (!identity.key) {
    console.log('  ' + UIHelper.dim(`${UIHelper.command(`dss key rotate ${identity.name}`)} to add one`));
  }

  // Only when cwd genuinely IS a git repo (bindingStatus resolved without
  // throwing) and it's simply unbound — not when cwd isn't a repo at all.
  if (source === 'global default' && bindingStatus && !bindingStatus.bound) {
    console.log(
      '  ' + UIHelper.dim(`· this repo uses the global identity — ${UIHelper.command(`dss link ${identity.name}`)} to bind it`)
    );
  }

  console.log('');
  const count = store.identities.length;
  console.log(UIHelper.dim(`${count} identit${count === 1 ? 'y' : 'ies'} · ${UIHelper.command('dss ls')}`));
  console.log(UIHelper.dim(`${UIHelper.command('dss doctor')} for a full check`));
}
