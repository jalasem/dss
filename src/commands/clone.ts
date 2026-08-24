import path from 'path';
import fs from 'fs-extra';
import { parseGitUrl, ParsedGitUrl } from '../core/gitUrl';
import { matchRule } from '../core/rules';
import { findIdentity } from '../core/identity';
import { IIdentity, IStoreV2 } from '../core/types';
import { loadStore, toSpace, recordBinding } from '../infra/store';
import { canonicalizeRuleDir } from '../infra/rules';
import { bindRepository, buildSshCommand } from '../infra/repoBinding';
import { runGitClone, GitCloneError } from '../infra/gitClone';
import { guardedSelect, UsageError } from './prompts';
import { UIHelper } from './ui';
import { fail } from './fail';
import { isJsonMode, jsonData } from './jsonOutput';
import { updateBindingRegistry } from './binding';

export interface CloneCommandOptions {
  identity?: string;
}

type SelectionReason = 'flag' | 'rule' | 'host' | 'selected';

interface IdentitySelection {
  identity: IIdentity;
  reason: SelectionReason;
}

/**
 * `dss clone <url> [directory]`'s 4-step identity selection, per the brief
 * (never guess on ambiguity): `--identity` flag > directory rule matching
 * where the clone will LIVE > exactly-one host match (auto-picked; several
 * prompts, interactively, among just those) > an interactive pick among
 * every identity. The two prompt cases share `reason: "selected"` — the
 * JSON payload only distinguishes flag/rule/host/selected, not which of the
 * two prompts produced a "selected" pick.
 */
async function selectIdentity(
  store: IStoreV2,
  parsed: ParsedGitUrl,
  canonicalDest: string,
  identityFlag: string | undefined
): Promise<IdentitySelection> {
  if (identityFlag) {
    const identity = findIdentity(store, identityFlag);
    if (!identity) {
      throw new Error(`Identity "${identityFlag}" was not found.`);
    }
    return { identity, reason: 'flag' };
  }

  const rule = matchRule(canonicalDest, store.rules);
  if (rule) {
    const identity = findIdentity(store, rule.identity);
    if (identity) return { identity, reason: 'rule' };
  }

  if (parsed.host) {
    const hostMatches = store.identities.filter(candidate => candidate.host === parsed.host);
    if (hostMatches.length === 1) {
      return { identity: hostMatches[0], reason: 'host' };
    }
    if (hostMatches.length > 1) {
      const chosenName = await guardedSelect({
        message: `Several identities use ${parsed.host}:`,
        choices: hostMatches.map(candidate => ({
          name: candidate.name,
          value: candidate.name,
          description: `${candidate.email} (${candidate.userName})`
        })),
        flagName: '-i/--identity',
      });
      return { identity: findIdentity(store, chosenName)!, reason: 'selected' };
    }
  }

  if (store.identities.length === 0) {
    throw new Error('No identities have been configured.');
  }

  const chosenName = await guardedSelect({
    message: 'Choose an identity to clone with:',
    choices: store.identities.map(candidate => ({
      name: candidate.name,
      value: candidate.name,
      description: `${candidate.email} (${candidate.userName})`
    })),
    flagName: '-i/--identity',
  });
  return { identity: findIdentity(store, chosenName)!, reason: 'selected' };
}

/** True in interactive (rich-TTY, non-JSON/PLAIN) mode — the mode in which
 * git's own clone progress is relayed live instead of captured silently. */
function isInteractiveClone(): boolean {
  return !isJsonMode() && !UIHelper.isPlain();
}

/**
 * `dss clone <url> [directory]`: parses the URL (core/gitUrl), picks the
 * right identity (flag > rule > host > interactive — see selectIdentity),
 * clones with a keyed `GIT_SSH_COMMAND` when the URL is ssh-style and the
 * identity has a key, then binds the fresh clone to that identity through
 * the exact same path/registry `dss link` uses (bindRepository +
 * updateBindingRegistry, both reused from commands/binding.ts).
 */
export async function cloneRepository(
  url: string,
  directory: string | undefined,
  options: CloneCommandOptions = {}
): Promise<void> {
  try {
    const parsed = parseGitUrl(url);
    if (!parsed) {
      throw new UsageError(`Unrecognized Git URL: ${JSON.stringify(url)}`);
    }

    const dest = path.resolve(process.cwd(), directory || parsed.repoName);

    if (await fs.pathExists(dest)) {
      fail(`Destination already exists: ${dest}`);
      return;
    }

    // The rule that will apply once the repo actually lives at `dest` — the
    // clone hasn't happened yet, so `dest` itself can't be realpath'd (it
    // doesn't exist). Canonicalize the PARENT (which normally does exist)
    // the same way rule directories are stored (infra/rules.ts's
    // canonicalizeRuleDir), then rejoin the destination's own basename.
    const canonicalParent = await canonicalizeRuleDir(path.dirname(dest));
    const canonicalDest = path.join(canonicalParent, path.basename(dest));

    const store = await loadStore();
    const { identity, reason } = await selectIdentity(store, parsed, canonicalDest, options.identity);
    const space = toSpace(identity);

    let sshCommand: string | undefined;
    if (parsed.isSsh) {
      if (space.sshKeyPath) {
        sshCommand = buildSshCommand(space.sshKeyPath);
      } else {
        UIHelper.warning(`Identity "${identity.name}" has no SSH key; clone will use your ambient SSH setup.`);
      }
    }

    const interactive = isInteractiveClone();
    const env = sshCommand ? { ...process.env, GIT_SSH_COMMAND: sshCommand } : undefined;

    try {
      await runGitClone(url, dest, { env, interactive });
    } catch (error) {
      fail(error instanceof GitCloneError ? error.message : `git clone failed: ${(error as Error).message}`);
      return;
    }

    let bound = false;
    try {
      const status = await bindRepository(dest, space, {});
      await updateBindingRegistry(registryStore => recordBinding(registryStore, status.repositoryRoot, space.name));
      bound = true;
    } catch (error) {
      UIHelper.warning(`Cloned, but could not bind "${identity.name}": ${(error as Error).message}`);
    }

    UIHelper.success(`Cloned ${parsed.repoName} ${UIHelper.dim('·')} ${UIHelper.highlight(identity.name)} ${UIHelper.dim(`(${reason})`)}`);
    UIHelper.print(UIHelper.dim(bound ? `  bound to ${identity.name}` : '  not bound — bind it by hand with dss link'));

    jsonData({ cloned: dest, url, identity: identity.name, reason, bound });
  } catch (error) {
    if (error instanceof UsageError) throw error;
    fail(error instanceof Error ? error.message : String(error));
  }
}
