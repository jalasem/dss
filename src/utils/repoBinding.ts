import { execFile } from 'child_process';
import fs from 'fs-extra';
import path from 'path';
import { promisify } from 'util';
import { ISpace } from './types';

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    encoding: 'utf8'
  });

  return stdout.trim();
}

const EXCLUDED_DIRECTORIES = new Set(['.git', 'node_modules']);

export interface RepositoryBindingStatus {
  repositoryRoot: string;
  configPath: string;
  bound: boolean;
  spaceName?: string;
  userName?: string;
  email?: string;
  sshCommand?: string;
}

interface BindingOptions {
  dryRun?: boolean;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildSshCommand(sshKeyPath: string): string {
  return `ssh -i ${shellQuote(sshKeyPath)} -o IdentitiesOnly=yes`;
}

async function resolveBindingConfigPath(repositoryRoot: string): Promise<string> {
  const gitPath = await runGit(repositoryRoot, ['rev-parse', '--git-path', 'dss/config']);
  return path.resolve(repositoryRoot, gitPath);
}

async function readOptionalGitConfig(
  repositoryRoot: string,
  args: string[]
): Promise<string | undefined> {
  try {
    return await runGit(repositoryRoot, args);
  } catch {
    return undefined;
  }
}

async function getLocalIncludes(repositoryRoot: string): Promise<string[]> {
  const output = await readOptionalGitConfig(repositoryRoot, [
    'config', '--local', '--get-all', 'include.path'
  ]);
  return output ? output.split('\n').filter(Boolean) : [];
}

async function writeBindingConfig(configPath: string, space: ISpace): Promise<void> {
  await fs.ensureDir(path.dirname(configPath));
  const temporaryPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.ensureFile(temporaryPath);

  try {
    const directory = path.dirname(configPath);
    await runGit(directory, ['config', '--file', temporaryPath, 'user.name', space.userName]);
    await runGit(directory, ['config', '--file', temporaryPath, 'user.email', space.email]);
    await runGit(directory, [
      'config',
      '--file',
      temporaryPath,
      'core.sshCommand',
      buildSshCommand(space.sshKeyPath)
    ]);
    await runGit(directory, ['config', '--file', temporaryPath, 'dss.space', space.name]);
    await fs.move(temporaryPath, configPath, { overwrite: true });
  } catch (error) {
    await fs.remove(temporaryPath);
    throw error;
  }
}

export async function resolveRepositoryRoot(startPath: string): Promise<string> {
  const requestedPath = path.resolve(startPath);
  const repositoryRoot = await runGit(requestedPath, ['rev-parse', '--show-toplevel']);

  return fs.realpath(repositoryRoot);
}

export async function discoverRepositories(_parentPath: string): Promise<string[]> {
  const parent = path.resolve(_parentPath);
  const parentStats = await fs.lstat(parent);

  if (parentStats.isSymbolicLink()) {
    throw new Error(`Recursive path is a symbolic link: ${parent}`);
  }

  if (!parentStats.isDirectory()) {
    throw new Error(`Recursive path is not a directory: ${parent}`);
  }

  const repositories = new Set<string>();

  async function walk(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });

    if (entries.some(entry => entry.name === '.git')) {
      try {
        repositories.add(await resolveRepositoryRoot(directory));
      } catch {
        // Ignore stale .git markers.
      }
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        continue;
      }

      if (EXCLUDED_DIRECTORIES.has(entry.name)) {
        continue;
      }

      await walk(path.join(directory, entry.name));
    }
  }

  await walk(parent);

  return [...repositories].sort((left, right) => left.localeCompare(right));
}

export async function getRepositoryBindingStatus(
  repositoryPath: string
): Promise<RepositoryBindingStatus> {
  const repositoryRoot = await resolveRepositoryRoot(repositoryPath);
  const configPath = await resolveBindingConfigPath(repositoryRoot);
  const includes = await getLocalIncludes(repositoryRoot);
  const bound = includes.includes(configPath) && await fs.pathExists(configPath);

  if (!bound) {
    return { repositoryRoot, configPath, bound: false };
  }

  return {
    repositoryRoot,
    configPath,
    bound: true,
    spaceName: await readOptionalGitConfig(repositoryRoot, ['config', '--file', configPath, 'dss.space']),
    userName: await readOptionalGitConfig(repositoryRoot, ['config', 'user.name']),
    email: await readOptionalGitConfig(repositoryRoot, ['config', 'user.email']),
    sshCommand: await readOptionalGitConfig(repositoryRoot, ['config', 'core.sshCommand'])
  };
}

export async function bindRepository(
  repositoryPath: string,
  space: ISpace,
  options: BindingOptions = {}
): Promise<RepositoryBindingStatus> {
  const repositoryRoot = await resolveRepositoryRoot(repositoryPath);
  const configPath = await resolveBindingConfigPath(repositoryRoot);

  if (options.dryRun) {
    return {
      repositoryRoot,
      configPath,
      bound: false,
      spaceName: space.name,
      userName: space.userName,
      email: space.email,
      sshCommand: buildSshCommand(space.sshKeyPath)
    };
  }

  await writeBindingConfig(configPath, space);
  const includes = await getLocalIncludes(repositoryRoot);
  if (!includes.includes(configPath)) {
    await runGit(repositoryRoot, ['config', '--local', '--add', 'include.path', configPath]);
  }

  return getRepositoryBindingStatus(repositoryRoot);
}

export async function unbindRepository(
  repositoryPath: string,
  options: BindingOptions = {}
): Promise<RepositoryBindingStatus> {
  const repositoryRoot = await resolveRepositoryRoot(repositoryPath);
  const configPath = await resolveBindingConfigPath(repositoryRoot);

  if (options.dryRun) {
    return getRepositoryBindingStatus(repositoryRoot);
  }

  const includes = await getLocalIncludes(repositoryRoot);
  if (includes.includes(configPath)) {
    await runGit(repositoryRoot, [
      'config',
      '--local',
      '--fixed-value',
      '--unset-all',
      'include.path',
      configPath
    ]);
  }
  await fs.remove(configPath);

  return getRepositoryBindingStatus(repositoryRoot);
}
