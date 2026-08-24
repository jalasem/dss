import { guardedSelect, guardedConfirm, UsageError } from './prompts';
import path from 'path';
import {
  bindRepositories,
  bindRepository,
  discoverRepositories,
  getRepositoryBindingStatus,
  RepositoryBindingStatus,
  unbindRepository
} from '../infra/repoBinding';
import { IConfig, ISpace } from '../core/types';
import { UIHelper } from './ui';
import { fail } from './fail';
import { EXIT_CODES } from '../core/exitCodes';
import { findSpace } from '../core/identity';
import { loadStore, saveStore, toSpace, recordBinding, removeBinding } from '../infra/store';
import { jsonData, isJsonMode } from './jsonOutput';

export interface BindCommandOptions {
  path?: string;
  recursive?: string | boolean;
  dryRun?: boolean;
}

export interface RepositoryCommandOptions {
  path?: string;
  dryRun?: boolean;
}

async function resolveSpace(spaceName?: string): Promise<ISpace | undefined> {
  const store = await loadStore();
  const config: IConfig = { spaces: store.identities.map(toSpace), activeSpace: store.active };
  if (config.spaces.length === 0) return undefined;

  const selectedName = spaceName || await guardedSelect({
    message: 'Choose an identity to bind:',
    choices: config.spaces.map(space => ({
      name: space.name,
      value: space.name,
      description: `${space.email} (${space.userName})`
    })),
    flagName: 'the identityName argument',
  });

  return findSpace(config, selectedName);
}

/** Best-effort: updates the binding registry after a successful bind/unbind
 * without failing the overall operation if the registry write fails.
 * Exported so `dss clone` (src/commands/clone.ts) can record its own
 * post-clone bind through the exact same path `dss link` uses, instead of
 * duplicating this try/catch-and-warn shape. */
export async function updateBindingRegistry(
  update: (store: Awaited<ReturnType<typeof loadStore>>) => void
): Promise<void> {
  try {
    const store = await loadStore();
    update(store);
    await saveStore(store);
  } catch (error) {
    UIHelper.warning(`Failed to update the binding registry: ${(error as Error).message}`);
  }
}

function printStatus(status: RepositoryBindingStatus): void {
  UIHelper.printStatus('Repository', status.repositoryRoot, 'info');
  UIHelper.printStatus('Binding', status.spaceName || 'Not bound', status.bound ? 'success' : 'info');
  if (status.userName) UIHelper.printStatus('Git User', status.userName, 'info');
  if (status.email) UIHelper.printStatus('Git Email', status.email, 'info');
  if (status.sshCommand) UIHelper.printStatus('SSH Command', status.sshCommand, 'info');
}

export async function bindSpaceToRepository(
  spaceName?: string,
  options: BindCommandOptions = {}
): Promise<void> {
  try {
    const recursiveRequested = options.recursive !== undefined && options.recursive !== false;
    if (options.path && recursiveRequested) {
      fail('--path and --recursive are mutually exclusive.');
      return;
    }

    const space = await resolveSpace(spaceName);
    if (!space) {
      fail(spaceName ? `Identity "${spaceName}" was not found.` : 'No identities have been configured.');
      return;
    }
    if (!space.sshKeyPath?.trim()) {
      fail(`Identity "${space.name}" does not have an SSH key.`);
      return;
    }

    if (!recursiveRequested) {
      const status = await bindRepository(options.path || process.cwd(), space, {
        dryRun: options.dryRun
      });
      if (options.dryRun) {
        UIHelper.info('Dry run: no repository configuration was changed.');
      } else {
        await updateBindingRegistry(store => recordBinding(store, status.repositoryRoot, space.name));
      }
      printStatus(status);
      jsonData({ bound: [{ path: status.repositoryRoot, identity: space.name }], failed: [] });
      return;
    }

    const recursiveParent = typeof options.recursive === 'string'
      ? options.recursive
      : process.cwd();
    const repositories = await discoverRepositories(recursiveParent);
    if (repositories.length === 0) {
      fail(`No Git repositories found beneath ${path.resolve(recursiveParent)}.`);
      return;
    }

    UIHelper.printHeader(options.dryRun ? 'Recursive Binding Preview' : 'Repositories to Bind');
    repositories.forEach(repository => UIHelper.print(`  ${repository}`));

    if (!options.dryRun) {
      // Required-affirm (recursive-bind approval): touches every matching
      // repository's local Git config, so non-interactive mode without -y
      // errors (exit 2) rather than proceeding unattended.
      const approved = await guardedConfirm({
        message: `Bind ${repositories.length} repositories to "${space.name}"?`,
        default: false
      });
      if (!approved) {
        UIHelper.info('Repository binding cancelled.');
        return;
      }
    }

    const result = await bindRepositories(repositories, space, { dryRun: options.dryRun });
    if (!options.dryRun) {
      for (const status of result.successful) {
        await updateBindingRegistry(store => recordBinding(store, status.repositoryRoot, space.name));
      }
    }
    result.successful.forEach(printStatus);
    result.failed.forEach(item => UIHelper.error(`${item.repositoryPath}: ${item.message}`));
    if (result.failed.length > 0) process.exitCode = EXIT_CODES.FAILURE;
    UIHelper.info(`${result.successful.length} succeeded, ${result.failed.length} failed.`);
    jsonData({
      bound: result.successful.map(status => ({ path: status.repositoryRoot, identity: space.name })),
      failed: result.failed,
    });
  } catch (error) {
    // A UsageError from a guarded prompt (resolveSpace's identity picker,
    // the recursive-bind confirm) carries its own exit-2 contract — let it
    // propagate to index.ts's top-level handler instead of being flattened
    // into fail()'s exit 1 here.
    if (error instanceof UsageError) throw error;
    fail(error instanceof Error ? error.message : String(error));
  }
}

export async function unbindSpaceFromRepository(
  options: RepositoryCommandOptions = {}
): Promise<void> {
  try {
    const targetPath = options.path || process.cwd();
    // unbindRepository's own returned status reflects the POST-removal
    // state (already unbound) once it's actually run — check the PRE-op
    // state ourselves so the JSON payload can report which path (if any)
    // actually had a binding removed. Gated on isJsonMode() (review
    // finding #4): this extra git subprocess call is only useful for the
    // JSON payload below, so the non-JSON path stays byte-for-byte
    // unchanged (no extra `git rev-parse`/`git config` calls it didn't
    // already make before this task).
    const wasBound = isJsonMode() ? (await getRepositoryBindingStatus(targetPath)).bound : false;
    const status = await unbindRepository(targetPath, {
      dryRun: options.dryRun
    });
    if (options.dryRun) {
      UIHelper.info(
        status.bound
          ? 'Dry run: the existing binding would be removed.'
          : 'Dry run: there is no binding to remove.'
      );
    } else {
      await updateBindingRegistry(store => removeBinding(store, status.repositoryRoot));
    }
    printStatus(status);
    if (isJsonMode()) jsonData({ unbound: wasBound ? status.repositoryRoot : null });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

export async function showRepositoryBindingStatus(
  options: RepositoryCommandOptions = {}
): Promise<void> {
  try {
    const status = await getRepositoryBindingStatus(options.path || process.cwd());
    printStatus(status);
    jsonData({ ...status });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
