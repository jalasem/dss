import { execFile } from 'child_process';
import fs from 'fs-extra';
import path from 'path';
import { promisify } from 'util';
import { ISpace } from './types';

const execFileAsync = promisify(execFile);
const GIT_REPOSITORY_ENVIRONMENT_VARIABLES = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
  'GIT_PREFIX'
] as const;

function gitEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const variable of GIT_REPOSITORY_ENVIRONMENT_VARIABLES) {
    delete environment[variable];
  }
  return environment;
}

async function runGit(
  cwd: string,
  args: string[],
  trimOutput: boolean = true
): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: gitEnvironment()
  });

  return trimOutput ? stdout.trim() : stdout;
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

interface BindingLocation {
  configPath: string;
  conditionKey: string;
}

export interface BatchBindingFailure {
  repositoryPath: string;
  message: string;
}

export interface BatchBindingResult {
  successful: RepositoryBindingStatus[];
  failed: BatchBindingFailure[];
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildSshCommand(sshKeyPath: string): string {
  return `ssh -i ${shellQuote(sshKeyPath)} -o IdentitiesOnly=yes`;
}

function isPathWithin(directory: string, candidate: string): boolean {
  const relativePath = path.relative(directory, candidate);
  return relativePath !== ''
    && relativePath !== '..'
    && !relativePath.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relativePath);
}

async function assertBindingConfigPathContained(
  configPath: string,
  realGitDirectory: string
): Promise<void> {
  if (!isPathWithin(realGitDirectory, configPath)) {
    throw new Error(`DSS config path escapes Git directory: ${configPath}`);
  }

  const pathComponents = path.relative(realGitDirectory, configPath).split(path.sep);
  let existingAncestor = realGitDirectory;

  for (const component of pathComponents) {
    const candidate = path.join(existingAncestor, component);

    try {
      const stats = await fs.lstat(candidate);
      if (stats.isSymbolicLink()) {
        throw new Error(`DSS config path contains a symbolic link: ${candidate}`);
      }
      existingAncestor = candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        break;
      }
      throw error;
    }
  }

  const realAncestor = await fs.realpath(existingAncestor);
  const realConfigPath = path.resolve(
    realAncestor,
    path.relative(existingAncestor, configPath)
  );
  if (!isPathWithin(realGitDirectory, realConfigPath)) {
    throw new Error(`DSS config path escapes Git directory: ${configPath}`);
  }
}

function escapeGitdirPattern(gitDirectory: string): string {
  // Git config subsection names cannot contain literal newlines.
  return gitDirectory
    .replace(/\\/g, '\\\\')
    .replace(/([*?[\]])/g, '\\$1')
    .replace(/[\r\n]/g, '?');
}

async function resolveBindingLocation(repositoryRoot: string): Promise<BindingLocation> {
  const gitDirectory = await runGit(repositoryRoot, ['rev-parse', '--absolute-git-dir']);
  const realGitDirectory = await fs.realpath(gitDirectory);
  const gitPath = await runGit(repositoryRoot, ['rev-parse', '--git-path', 'dss/config']);
  const configPath = path.resolve(repositoryRoot, gitPath);
  await assertBindingConfigPathContained(configPath, realGitDirectory);
  return {
    configPath,
    conditionKey: `includeIf.gitdir:${escapeGitdirPattern(realGitDirectory)}.path`
  };
}

async function readOptionalGitConfig(
  repositoryRoot: string,
  args: string[],
  trimOutput: boolean = true
): Promise<string | undefined> {
  try {
    return await runGit(repositoryRoot, args, trimOutput);
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) {
      return undefined;
    }
    throw error;
  }
}

async function getConditionalIncludes(
  repositoryRoot: string,
  conditionKey: string
): Promise<string[]> {
  const output = await readOptionalGitConfig(repositoryRoot, [
    'config', '-z', '--local', '--get-all', conditionKey
  ], false);
  return output ? output.split('\0').filter(Boolean) : [];
}

async function removeExactConditionalIncludes(
  repositoryRoot: string,
  conditionKey: string,
  configPath: string
): Promise<void> {
  await runGit(repositoryRoot, [
    'config',
    '--local',
    '--fixed-value',
    '--unset-all',
    conditionKey,
    configPath
  ]);
}

async function addConditionalInclude(
  repositoryRoot: string,
  conditionKey: string,
  configPath: string
): Promise<void> {
  await runGit(repositoryRoot, [
    'config', '--local', '--add', conditionKey, configPath
  ]);
}

async function normalizeConditionalInclude(
  repositoryRoot: string,
  conditionKey: string,
  configPath: string,
  includes: string[]
): Promise<void> {
  const exactCount = includes.filter(include => include === configPath).length;
  if (exactCount === 1) return;

  if (exactCount > 0) {
    await removeExactConditionalIncludes(repositoryRoot, conditionKey, configPath);
  }

  try {
    await addConditionalInclude(repositoryRoot, conditionKey, configPath);
  } catch (error) {
    if (exactCount > 0) {
      try {
        for (let index = 0; index < exactCount; index += 1) {
          await addConditionalInclude(repositoryRoot, conditionKey, configPath);
        }
      } catch (rollbackError) {
        throw new Error(
          `${errorMessage(error)}; failed to restore conditional includes: ${errorMessage(rollbackError)}`
        );
      }
    }
    throw error;
  }
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

async function removeBindingConfig(configPath: string): Promise<void> {
  await fs.remove(configPath);
  const directory = path.dirname(configPath);
  try {
    if ((await fs.readdir(directory)).length === 0) {
      await fs.rmdir(directory);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function restoreBindingConfig(
  configPath: string,
  previousContents: Buffer | undefined
): Promise<void> {
  if (previousContents === undefined) {
    await removeBindingConfig(configPath);
    return;
  }
  await fs.writeFile(configPath, previousContents);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  const { configPath, conditionKey } = await resolveBindingLocation(repositoryRoot);
  const includes = await getConditionalIncludes(repositoryRoot, conditionKey);
  const bound = includes.includes(configPath) && await fs.pathExists(configPath);
  const [spaceName, userName, email, sshCommand] = await Promise.all([
    bound
      ? readOptionalGitConfig(repositoryRoot, ['config', '--file', configPath, 'dss.space'])
      : undefined,
    readOptionalGitConfig(repositoryRoot, ['config', 'user.name']),
    readOptionalGitConfig(repositoryRoot, ['config', 'user.email']),
    readOptionalGitConfig(repositoryRoot, ['config', 'core.sshCommand'])
  ]);

  return {
    repositoryRoot,
    configPath,
    bound,
    spaceName,
    userName,
    email,
    sshCommand
  };
}

export async function bindRepository(
  repositoryPath: string,
  space: ISpace,
  options: BindingOptions = {}
): Promise<RepositoryBindingStatus> {
  const repositoryRoot = await resolveRepositoryRoot(repositoryPath);
  const { configPath, conditionKey } = await resolveBindingLocation(repositoryRoot);

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

  const includes = await getConditionalIncludes(repositoryRoot, conditionKey);
  const previousContents = await fs.pathExists(configPath)
    ? await fs.readFile(configPath)
    : undefined;
  await writeBindingConfig(configPath, space);
  try {
    await normalizeConditionalInclude(
      repositoryRoot,
      conditionKey,
      configPath,
      includes
    );
  } catch (error) {
    await restoreBindingConfig(configPath, previousContents);
    throw error;
  }

  return getRepositoryBindingStatus(repositoryRoot);
}

export async function bindRepositories(
  repositoryPaths: string[],
  space: ISpace,
  options: BindingOptions = {}
): Promise<BatchBindingResult> {
  const result: BatchBindingResult = { successful: [], failed: [] };

  for (const repositoryPath of repositoryPaths) {
    try {
      result.successful.push(await bindRepository(repositoryPath, space, options));
    } catch (error) {
      result.failed.push({ repositoryPath, message: errorMessage(error) });
    }
  }

  return result;
}

export async function unbindRepository(
  repositoryPath: string,
  options: BindingOptions = {}
): Promise<RepositoryBindingStatus> {
  const repositoryRoot = await resolveRepositoryRoot(repositoryPath);
  const { configPath, conditionKey } = await resolveBindingLocation(repositoryRoot);

  if (options.dryRun) {
    return getRepositoryBindingStatus(repositoryRoot);
  }

  const includes = await getConditionalIncludes(repositoryRoot, conditionKey);
  if (includes.includes(configPath)) {
    await removeExactConditionalIncludes(repositoryRoot, conditionKey, configPath);
  }
  await removeBindingConfig(configPath);

  return getRepositoryBindingStatus(repositoryRoot);
}
