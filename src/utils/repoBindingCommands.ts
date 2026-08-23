import { select } from '@inquirer/prompts';
import { safeConfirm } from './prompts';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import {
  bindRepositories,
  bindRepository,
  discoverRepositories,
  getRepositoryBindingStatus,
  RepositoryBindingStatus,
  unbindRepository
} from './repoBinding';
import { IConfig, ISpace } from './types';
import { UIHelper } from './ui';
import { fail } from './fail';
import { findSpace } from './spaceLookup';

export interface BindCommandOptions {
  path?: string;
  recursive?: string | boolean;
  dryRun?: boolean;
}

export interface RepositoryCommandOptions {
  path?: string;
  dryRun?: boolean;
}

const configPath = path.join(os.homedir(), '.dss', 'spaces', 'config.json');

async function resolveSpace(spaceName?: string): Promise<ISpace | undefined> {
  if (!(await fs.pathExists(configPath))) return undefined;

  const config: Partial<IConfig> = await fs.readJson(configPath);
  if (!Array.isArray(config.spaces) || config.spaces.length === 0) return undefined;

  const selectedName = spaceName || await select({
    message: 'Choose a space to bind:',
    choices: config.spaces.map(space => ({
      name: space.name,
      value: space.name,
      description: `${space.email} (${space.userName})`
    }))
  });

  return findSpace(config as IConfig, selectedName);
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
      fail(spaceName ? `Space "${spaceName}" was not found.` : 'No spaces have been configured.');
      return;
    }
    if (!space.sshKeyPath?.trim()) {
      fail(`Space "${space.name}" does not have an SSH key.`);
      return;
    }

    if (!recursiveRequested) {
      const status = await bindRepository(options.path || process.cwd(), space, {
        dryRun: options.dryRun
      });
      if (options.dryRun) UIHelper.info('Dry run: no repository configuration was changed.');
      printStatus(status);
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
    repositories.forEach(repository => console.log(`  ${repository}`));

    if (!options.dryRun) {
      const approved = await safeConfirm({
        message: `Bind ${repositories.length} repositories to "${space.name}"?`,
        default: false
      });
      if (!approved) {
        UIHelper.info('Repository binding cancelled.');
        return;
      }
    }

    const result = await bindRepositories(repositories, space, { dryRun: options.dryRun });
    result.successful.forEach(printStatus);
    result.failed.forEach(item => UIHelper.error(`${item.repositoryPath}: ${item.message}`));
    if (result.failed.length > 0) process.exitCode = 1;
    UIHelper.info(`${result.successful.length} succeeded, ${result.failed.length} failed.`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

export async function unbindSpaceFromRepository(
  options: RepositoryCommandOptions = {}
): Promise<void> {
  try {
    const status = await unbindRepository(options.path || process.cwd(), {
      dryRun: options.dryRun
    });
    if (options.dryRun) {
      UIHelper.info(
        status.bound
          ? 'Dry run: the existing binding would be removed.'
          : 'Dry run: there is no binding to remove.'
      );
    }
    printStatus(status);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

export async function showRepositoryBindingStatus(
  options: RepositoryCommandOptions = {}
): Promise<void> {
  try {
    printStatus(await getRepositoryBindingStatus(options.path || process.cwd()));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
