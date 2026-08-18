import { execFile } from 'child_process';
import fs from 'fs-extra';
import path from 'path';
import { promisify } from 'util';
import { ISpace } from './types';

const execFileAsync = promisify(execFile);
const MINIMUM_REPOSITORY_BINDING_GIT_VERSION = {
  major: 2,
  minor: 30,
  patch: 0
} as const;
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

  return trimOutput && stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;
}

async function runGitVersion(): Promise<string> {
  const { stdout } = await execFileAsync('git', ['--version'], {
    encoding: 'utf8',
    env: gitEnvironment()
  });

  return stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;
}

const EXCLUDED_DIRECTORIES = new Set(['.git', 'node_modules']);

/** Describes the effective identity and binding state of a repository. */
export interface RepositoryBindingStatus {
  repositoryRoot: string;
  configPath: string;
  bound: boolean;
  spaceName?: string;
  userName?: string;
  email?: string;
  sshCommand?: string;
}

/** Represents the numeric components reported by Git. */
export interface GitVersion {
  major: number;
  minor: number;
  patch: number;
}

interface BindingOptions {
  dryRun?: boolean;
  gitVersionCheck?: Promise<void>;
}

interface BindingLocation {
  configPath: string;
  conditionKey: string;
  gitDirectory: string;
}

/** Records a repository that could not be processed in a batch. */
export interface BatchBindingFailure {
  repositoryPath: string;
  message: string;
}

/** Contains successful bindings and per-repository failures from a batch. */
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
  // CR/LF substitution exists only to diagnose and remove legacy bindings.
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
    conditionKey: `includeIf.gitdir:${escapeGitdirPattern(realGitDirectory)}.path`,
    gitDirectory: realGitDirectory
  };
}

function assertBindableGitDirectory(gitDirectory: string): void {
  if (/[\r\n]/.test(gitDirectory)) {
    throw new Error(
      'DSS cannot bind a repository whose canonical Git directory contains ' +
      `a carriage return or line feed: ${JSON.stringify(gitDirectory)}`
    );
  }
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

async function ensureConditionalInclude(
  repositoryRoot: string,
  conditionKey: string,
  configPath: string,
  includes: string[]
): Promise<boolean> {
  const exactCount = includes.filter(include => include === configPath).length;
  if (exactCount > 0) return false;

  await addConditionalInclude(repositoryRoot, conditionKey, configPath);
  return true;
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

/** Parses a numeric Git version from `git --version` output. */
export function parseGitVersion(output: string): GitVersion | undefined {
  const match = /^git version\s+(\d+)\.(\d+)(?:\.(\d+))?(?=$|[.\s(])/.exec(output);
  if (!match) return undefined;

  const [, major, minor, patch = '0'] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch)
  };
}

/** Reports whether Git meets the minimum version for repository binding. */
export function isRepositoryBindingGitVersionSupported(output: string): boolean {
  const version = parseGitVersion(output);
  if (!version) return false;

  const minimum = MINIMUM_REPOSITORY_BINDING_GIT_VERSION;
  if (version.major !== minimum.major) return version.major > minimum.major;
  if (version.minor !== minimum.minor) return version.minor > minimum.minor;
  return version.patch >= minimum.patch;
}

async function assertRepositoryBindingGitVersion(): Promise<void> {
  const output = await runGitVersion();
  if (!isRepositoryBindingGitVersionSupported(output)) {
    throw new Error(
      'DSS repository binding requires Git 2.30 or newer. ' +
      `Found ${JSON.stringify(output)}; upgrade Git and retry.`
    );
  }
}

/** Resolves an input path to its canonical Git repository root. */
export async function resolveRepositoryRoot(startPath: string): Promise<string> {
  const requestedPath = path.resolve(startPath);
  const repositoryRoot = await runGit(requestedPath, ['rev-parse', '--show-toplevel']);

  return fs.realpath(repositoryRoot);
}

/** Recursively discovers repositories below a directory without following symlinks. */
export async function discoverRepositories(parentPath: string): Promise<string[]> {
  const parent = path.resolve(parentPath);
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

/** Reads the current repository-local binding and effective Git identity. */
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

/** Binds one repository to a space, optionally returning a dry-run preview. */
export async function bindRepository(
  repositoryPath: string,
  space: ISpace,
  options: BindingOptions = {}
): Promise<RepositoryBindingStatus> {
  const repositoryRoot = await resolveRepositoryRoot(repositoryPath);
  const { configPath, conditionKey, gitDirectory } = await resolveBindingLocation(
    repositoryRoot
  );
  assertBindableGitDirectory(gitDirectory);
  await (options.gitVersionCheck ?? assertRepositoryBindingGitVersion());

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
  let configWritten = false;
  let includeAdded = false;
  try {
    await writeBindingConfig(configPath, space);
    configWritten = true;
    includeAdded = await ensureConditionalInclude(
      repositoryRoot,
      conditionKey,
      configPath,
      includes
    );
    return await getRepositoryBindingStatus(repositoryRoot);
  } catch (error) {
    if (!configWritten) throw error;

    const rollbackErrors: unknown[] = [];
    if (includeAdded) {
      try {
        await removeExactConditionalIncludes(repositoryRoot, conditionKey, configPath);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    try {
      await restoreBindingConfig(configPath, previousContents);
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }

    if (rollbackErrors.length > 0) {
      const combinedError = new Error(
        `${errorMessage(error)}; binding rollback failed: ` +
        rollbackErrors.map(errorMessage).join('; ')
      );
      (combinedError as Error & { cause?: unknown }).cause = error;
      throw combinedError;
    }
    throw error;
  }
}

/** Binds repositories independently while collecting per-repository failures. */
export async function bindRepositories(
  repositoryPaths: string[],
  space: ISpace,
  options: BindingOptions = {}
): Promise<BatchBindingResult> {
  const result: BatchBindingResult = { successful: [], failed: [] };
  const gitVersionCheck = options.gitVersionCheck ?? (
    repositoryPaths.length > 0 ? assertRepositoryBindingGitVersion() : undefined
  );
  const batchOptions = { ...options, gitVersionCheck };

  for (const repositoryPath of repositoryPaths) {
    try {
      result.successful.push(await bindRepository(repositoryPath, space, batchOptions));
    } catch (error) {
      result.failed.push({ repositoryPath, message: errorMessage(error) });
    }
  }

  return result;
}

/** Removes a repository-local binding and restores the repository's prior identity. */
export async function unbindRepository(
  repositoryPath: string,
  options: BindingOptions = {}
): Promise<RepositoryBindingStatus> {
  const repositoryRoot = await resolveRepositoryRoot(repositoryPath);
  const { configPath, conditionKey } = await resolveBindingLocation(repositoryRoot);

  if (options.dryRun) {
    return getRepositoryBindingStatus(repositoryRoot);
  }

  await assertRepositoryBindingGitVersion();

  const includes = await getConditionalIncludes(repositoryRoot, conditionKey);
  if (includes.includes(configPath)) {
    await removeExactConditionalIncludes(repositoryRoot, conditionKey, configPath);
  }
  await removeBindingConfig(configPath);

  return getRepositoryBindingStatus(repositoryRoot);
}
