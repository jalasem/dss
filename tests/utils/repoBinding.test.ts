import { execFileSync } from 'child_process';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import {
  bindRepository,
  bindRepositories,
  discoverRepositories,
  getRepositoryBindingStatus,
  isRepositoryBindingGitVersionSupported,
  parseGitVersion,
  unbindRepository,
  resolveRepositoryRoot
} from '../../src/utils/repoBinding';
import { ISpace } from '../../src/utils/types';

function runGit(cwd: string, args: string[]): string {
  const output = execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return output.endsWith('\n') ? output.slice(0, -1) : output;
}

function runGitRaw(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function readGitValues(cwd: string, args: string[]): string[] {
  try {
    return runGitRaw(cwd, args).split('\0').filter(Boolean);
  } catch (error) {
    if ((error as { status?: unknown }).status === 1) {
      return [];
    }
    throw error;
  }
}

function readOptionalGitValue(cwd: string, args: string[]): string | undefined {
  try {
    return runGit(cwd, args);
  } catch (error) {
    if ((error as { status?: unknown }).status === 1) {
      return undefined;
    }
    throw error;
  }
}

async function bindingConditionKey(repository: string): Promise<string> {
  const gitDirectory = await fs.realpath(
    runGit(repository, ['rev-parse', '--absolute-git-dir'])
  );
  const pattern = gitDirectory
    .replace(/[?*[\]\\]/g, '\\$&')
    .replace(/[\r\n]/g, '?');
  return `includeIf.gitdir:${pattern}.path`;
}

async function commitFixture(repository: string): Promise<string> {
  runGit(repository, ['config', 'user.name', 'Fixture User']);
  runGit(repository, ['config', 'user.email', 'fixture@example.com']);
  await fs.writeFile(path.join(repository, 'README.md'), 'fixture\n');
  runGit(repository, ['add', 'README.md']);
  runGit(repository, ['commit', '-m', 'fixture']);
  return runGit(repository, ['branch', '--show-current']);
}

function readOptionalGlobalGitConfig(key: string): string | undefined {
  try {
    return execFileSync('git', ['config', '--global', '--get', key], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
  } catch {
    return undefined;
  }
}

async function createRepository(parent: string, name: string): Promise<string> {
  const repository = path.join(parent, name);
  await fs.ensureDir(repository);
  runGit(repository, ['init']);
  return repository;
}

async function renameWorktreeGitDirectory(
  worktree: string,
  newName: string
): Promise<string> {
  const originalGitDirectory = runGit(worktree, [
    'rev-parse', '--absolute-git-dir'
  ]);
  const renamedGitDirectory = path.join(path.dirname(originalGitDirectory), newName);
  await fs.move(originalGitDirectory, renamedGitDirectory);
  await fs.writeFile(path.join(worktree, '.git'), `gitdir: ${renamedGitDirectory}\n`);
  return renamedGitDirectory;
}

async function installGitVersionWrapper(
  parent: string,
  versionOutput: string
): Promise<() => void> {
  const gitWrapperDirectory = path.join(parent, 'git-wrapper-version');
  const gitWrapper = path.join(gitWrapperDirectory, 'git');
  const gitExecutable = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const originalPath = process.env.PATH;
  const originalGitExecutable = process.env.DSS_TEST_REAL_GIT;
  const originalVersionOutput = process.env.DSS_TEST_GIT_VERSION;
  await fs.ensureDir(gitWrapperDirectory);
  await fs.writeFile(
    gitWrapper,
    [
      '#!/usr/bin/env node',
      "const { execFileSync } = require('child_process');",
      'const args = process.argv.slice(2);',
      "if (args.includes('--version')) {",
      "  process.stdout.write(`${process.env.DSS_TEST_GIT_VERSION}\\n`);",
      '  process.exit(0);',
      '}',
      "execFileSync(process.env.DSS_TEST_REAL_GIT, args, { stdio: 'inherit' });",
      ''
    ].join('\n')
  );
  await fs.chmod(gitWrapper, 0o755);
  process.env.DSS_TEST_REAL_GIT = gitExecutable;
  process.env.DSS_TEST_GIT_VERSION = versionOutput;
  process.env.PATH = `${gitWrapperDirectory}${path.delimiter}${originalPath ?? ''}`;

  return () => {
    process.env.PATH = originalPath;
    if (originalGitExecutable === undefined) {
      delete process.env.DSS_TEST_REAL_GIT;
    } else {
      process.env.DSS_TEST_REAL_GIT = originalGitExecutable;
    }
    if (originalVersionOutput === undefined) {
      delete process.env.DSS_TEST_GIT_VERSION;
    } else {
      process.env.DSS_TEST_GIT_VERSION = originalVersionOutput;
    }
  };
}

async function installFinalStatusFailureWrapper(
  parent: string,
  configPath: string,
  failRollback: boolean = false
): Promise<() => void> {
  const gitWrapperDirectory = path.join(parent, 'git-wrapper-status-failure');
  const gitWrapper = path.join(gitWrapperDirectory, 'git');
  const gitExecutable = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const originalPath = process.env.PATH;
  const originalGitExecutable = process.env.DSS_TEST_REAL_GIT;
  const originalConfigPath = process.env.DSS_TEST_CONFIG_PATH;
  const originalFailRollback = process.env.DSS_TEST_FAIL_ROLLBACK;
  await fs.ensureDir(gitWrapperDirectory);
  await fs.writeFile(
    gitWrapper,
    [
      '#!/usr/bin/env node',
      "const { execFileSync } = require('child_process');",
      'const args = process.argv.slice(2);',
      "const configIndex = args.indexOf('config');",
      "if (process.env.DSS_TEST_FAIL_ROLLBACK === 'true' &&",
      "    args.includes('--unset-all')) {",
      "  process.stderr.write('simulated rollback failure\\n');",
      '  process.exit(2);',
      '}',
      "if (args[configIndex + 1] === '--file' &&",
      '    args[configIndex + 2] === process.env.DSS_TEST_CONFIG_PATH &&',
      "    args[configIndex + 3] === 'dss.space') {",
      "  process.stderr.write('simulated status failure\\n');",
      '  process.exit(2);',
      '}',
      "execFileSync(process.env.DSS_TEST_REAL_GIT, args, { stdio: 'inherit' });",
      ''
    ].join('\n')
  );
  await fs.chmod(gitWrapper, 0o755);
  process.env.DSS_TEST_REAL_GIT = gitExecutable;
  process.env.DSS_TEST_CONFIG_PATH = configPath;
  process.env.DSS_TEST_FAIL_ROLLBACK = String(failRollback);
  process.env.PATH = `${gitWrapperDirectory}${path.delimiter}${originalPath ?? ''}`;

  return () => {
    process.env.PATH = originalPath;
    if (originalGitExecutable === undefined) {
      delete process.env.DSS_TEST_REAL_GIT;
    } else {
      process.env.DSS_TEST_REAL_GIT = originalGitExecutable;
    }
    if (originalConfigPath === undefined) {
      delete process.env.DSS_TEST_CONFIG_PATH;
    } else {
      process.env.DSS_TEST_CONFIG_PATH = originalConfigPath;
    }
    if (originalFailRollback === undefined) {
      delete process.env.DSS_TEST_FAIL_ROLLBACK;
    } else {
      process.env.DSS_TEST_FAIL_ROLLBACK = originalFailRollback;
    }
  };
}

describe('repository targeting', () => {
  const temporaryDirectories: string[] = [];
  const personalSpace: ISpace = {
    name: 'personal',
    email: 'personal@example.com',
    userName: 'Personal User',
    sshKeyPath: "/tmp/DSS keys/key '$HOME; touch blocked'"
  };
  const workSpace: ISpace = {
    name: 'work',
    email: 'work@example.com',
    userName: 'Work User',
    sshKeyPath: '/tmp/work-key'
  };
  const clientSpace: ISpace = {
    name: 'client',
    email: 'client@example.com',
    userName: 'Client User',
    sshKeyPath: '/tmp/client-key'
  };

  async function createTemporaryDirectory(): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-binding-'));
    temporaryDirectories.push(directory);
    return fs.realpath(directory);
  }

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => fs.remove(directory)));
  });

  it.each([
    ['git version 2.29.9', { major: 2, minor: 29, patch: 9 }, false],
    ['git version 2.30.0', { major: 2, minor: 30, patch: 0 }, true],
    ['git version 2.39.3 (Apple Git-146)', { major: 2, minor: 39, patch: 3 }, true],
    ['git version 3.0.0', { major: 3, minor: 0, patch: 0 }, true]
  ])('parses and evaluates repository-binding compatibility for %s', (
    output,
    parsed,
    supported
  ) => {
    expect(parseGitVersion(output)).toEqual(parsed);
    expect(isRepositoryBindingGitVersionSupported(output)).toBe(supported);
  });

  it.each(['git version', 'git version two.thirty', 'not git'])
    ('rejects malformed Git version output %p', output => {
      expect(parseGitVersion(output)).toBeUndefined();
      expect(isRepositoryBindingGitVersionSupported(output)).toBe(false);
    });

  it('resolves the repository root from a nested working directory', async () => {
    const parent = await createTemporaryDirectory();
    const repository = await createRepository(parent, 'project');
    const nestedDirectory = path.join(repository, 'src', 'features');
    await fs.ensureDir(nestedDirectory);

    await expect(resolveRepositoryRoot(nestedDirectory)).resolves.toBe(
      await fs.realpath(repository)
    );
  });

  it('resolves an explicitly selected trailing-space repository without redirecting to its sibling', async () => {
    const parent = await createTemporaryDirectory();
    const trimmedRepository = await createRepository(parent, 'project');
    const suffixedRepository = await createRepository(parent, 'project ');

    await expect(resolveRepositoryRoot(suffixedRepository)).resolves.toBe(
      await fs.realpath(suffixedRepository)
    );
    await bindRepository(suffixedRepository, personalSpace);

    expect(runGit(suffixedRepository, ['config', 'user.email']))
      .toBe('personal@example.com');
    expect(readOptionalGitValue(trimmedRepository, ['config', 'dss.space']))
      .toBeUndefined();
  });

  it.each([' ', '\r', '\n'])(
    'discovers both trimmed and %p-suffixed repository paths',
    async suffix => {
      const parent = await createTemporaryDirectory();
      const trimmedRepository = await createRepository(parent, 'project');
      const suffixedRepository = await createRepository(parent, `project${suffix}`);

      expect(await discoverRepositories(parent)).toEqual(
        [
          await fs.realpath(trimmedRepository),
          await fs.realpath(suffixedRepository)
        ].sort((left, right) => left.localeCompare(right))
      );
    }
  );

  it('keeps explicit and current-directory targeting authoritative over Git environment variables', async () => {
    const parent = await createTemporaryDirectory();
    const requestedRepository = await createRepository(parent, 'requested');
    const poisonedRepository = await createRepository(parent, 'poisoned');
    const originalDirectory = process.cwd();
    const poisonedKeys = [
      'GIT_DIR',
      'GIT_WORK_TREE',
      'GIT_COMMON_DIR',
      'GIT_INDEX_FILE'
    ] as const;
    const originalValues = Object.fromEntries(
      poisonedKeys.map(key => [key, process.env[key]])
    );

    process.env.GIT_DIR = path.join(poisonedRepository, '.git');
    process.env.GIT_WORK_TREE = poisonedRepository;
    process.env.GIT_COMMON_DIR = path.join(poisonedRepository, '.git');
    process.env.GIT_INDEX_FILE = path.join(poisonedRepository, '.git', 'index');

    try {
      await expect(resolveRepositoryRoot(requestedRepository)).resolves.toBe(
        await fs.realpath(requestedRepository)
      );

      process.chdir(requestedRepository);
      await expect(resolveRepositoryRoot('.')).resolves.toBe(
        await fs.realpath(requestedRepository)
      );
    } finally {
      process.chdir(originalDirectory);
      for (const key of poisonedKeys) {
        const value = originalValues[key];
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it('discovers repositories deterministically without traversing excluded or symbolic-link directories', async () => {
    const parent = await createTemporaryDirectory();
    const alpha = await createRepository(parent, 'alpha');
    const source = await createRepository(parent, 'source');
    const ignored = await createRepository(path.join(parent, 'node_modules'), 'ignored');
    const externalParent = await createTemporaryDirectory();
    const external = await createRepository(externalParent, 'external');

    runGit(source, ['config', 'user.name', 'DSS Test']);
    runGit(source, ['config', 'user.email', 'dss@example.com']);
    await fs.writeFile(path.join(source, 'README.md'), 'fixture\n');
    runGit(source, ['add', 'README.md']);
    runGit(source, ['commit', '-m', 'test fixture']);

    const linked = path.join(parent, 'linked');
    runGit(source, ['worktree', 'add', '-b', 'linked-fixture', linked]);
    await fs.symlink(external, path.join(parent, 'external-link'));

    const repositories = await discoverRepositories(parent);

    expect(repositories).toEqual(
      [await fs.realpath(alpha), await fs.realpath(linked), await fs.realpath(source)].sort()
    );
    expect(repositories).not.toContain(await fs.realpath(ignored));
    expect(repositories).not.toContain(await fs.realpath(external));
  });

  it('rejects a symbolic link passed as the discovery root', async () => {
    const parent = await createTemporaryDirectory();
    const repository = await createRepository(parent, 'external');
    const symbolicLink = path.join(parent, 'external-link');

    await fs.symlink(repository, symbolicLink);

    await expect(discoverRepositories(symbolicLink)).rejects.toThrow(/symbolic link/i);
  });

  it('binds one repository through a single DSS include file', async () => {
    const parent = await createTemporaryDirectory();
    const repository = await createRepository(parent, 'project');

    const status = await bindRepository(repository, personalSpace);
    const conditionKey = await bindingConditionKey(repository);
    const includes = readGitValues(repository, [
      'config', '-z', '--local', '--get-all', conditionKey
    ]);

    expect(status.bound).toBe(true);
    expect(status.spaceName).toBe('personal');
    expect(runGit(repository, ['config', 'user.name'])).toBe('Personal User');
    expect(runGit(repository, ['config', 'user.email'])).toBe('personal@example.com');
    expect(runGit(repository, ['config', 'dss.space'])).toBe('personal');
    expect(runGit(repository, ['config', 'core.sshCommand'])).toBe(
      "ssh -i '/tmp/DSS keys/key '\\''$HOME; touch blocked'\\''' -o IdentitiesOnly=yes"
    );
    expect(includes).toEqual([status.configPath]);
    expect(status.configPath.startsWith(path.join(repository, '.git'))).toBe(true);
  });

  it('keeps linked worktree bindings independent through rebind and unbind', async () => {
    const parent = await createTemporaryDirectory();
    const repository = await createRepository(parent, 'project');
    await commitFixture(repository);
    const linkedWorktree = path.join(parent, 'linked');
    runGit(repository, ['worktree', 'add', '-b', 'linked-fixture', linkedWorktree]);

    await bindRepository(repository, personalSpace);
    await bindRepository(linkedWorktree, workSpace);

    expect(runGit(repository, ['config', 'user.name'])).toBe('Personal User');
    expect(runGit(repository, ['config', 'user.email'])).toBe('personal@example.com');
    expect(runGit(repository, ['config', 'core.sshCommand'])).toBe(
      "ssh -i '/tmp/DSS keys/key '\\''$HOME; touch blocked'\\''' -o IdentitiesOnly=yes"
    );
    await expect(getRepositoryBindingStatus(repository)).resolves.toMatchObject({
      bound: true,
      spaceName: 'personal'
    });
    expect(runGit(linkedWorktree, ['config', 'user.name'])).toBe('Work User');
    expect(runGit(linkedWorktree, ['config', 'user.email'])).toBe('work@example.com');
    expect(runGit(linkedWorktree, ['config', 'core.sshCommand']))
      .toBe("ssh -i '/tmp/work-key' -o IdentitiesOnly=yes");
    await expect(getRepositoryBindingStatus(linkedWorktree)).resolves.toMatchObject({
      bound: true,
      spaceName: 'work'
    });

    await bindRepository(repository, clientSpace);
    expect(runGit(repository, ['config', 'user.email'])).toBe('client@example.com');
    expect(runGit(linkedWorktree, ['config', 'user.email'])).toBe('work@example.com');

    await unbindRepository(repository);
    await expect(getRepositoryBindingStatus(repository)).resolves.toMatchObject({
      bound: false,
      userName: 'Fixture User',
      email: 'fixture@example.com'
    });
    await expect(getRepositoryBindingStatus(linkedWorktree)).resolves.toMatchObject({
      bound: true,
      spaceName: 'work'
    });

    await unbindRepository(linkedWorktree);
    await expect(getRepositoryBindingStatus(linkedWorktree)).resolves.toMatchObject({
      bound: false,
      userName: 'Fixture User',
      email: 'fixture@example.com'
    });
    expect(readOptionalGitValue(repository, [
      'config', '--local', '--get', 'extensions.worktreeConfig'
    ])).toBeUndefined();
  });

  it('preserves a shared core.worktree repository through bind and unbind', async () => {
    const parent = await createTemporaryDirectory();
    const repository = path.join(parent, 'worktree');
    const gitDirectory = path.join(parent, 'shared.git');
    execFileSync('git', ['init', '--separate-git-dir', gitDirectory, repository], {
      encoding: 'utf8',
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    runGit(repository, ['config', '--local', 'core.worktree', repository]);
    const originalRoot = runGit(repository, ['rev-parse', '--show-toplevel']);
    const originalCoreWorktree = runGit(repository, [
      'config', '--local', '--get', 'core.worktree'
    ]);

    await expect(bindRepository(repository, personalSpace)).resolves.toMatchObject({
      bound: true,
      spaceName: 'personal'
    });
    expect(runGit(repository, ['rev-parse', '--show-toplevel'])).toBe(originalRoot);
    expect(runGit(repository, ['config', '--local', '--get', 'core.worktree']))
      .toBe(originalCoreWorktree);

    await unbindRepository(repository);
    expect(runGit(repository, ['rev-parse', '--show-toplevel'])).toBe(originalRoot);
    expect(runGit(repository, ['config', '--local', '--get', 'core.worktree']))
      .toBe(originalCoreWorktree);
  });

  it('binds a linked worktree created from a bare repository without changing bare behavior', async () => {
    const parent = await createTemporaryDirectory();
    const source = await createRepository(parent, 'source');
    const branch = await commitFixture(source);
    const bareRepository = path.join(parent, 'bare.git');
    execFileSync('git', ['init', '--bare', bareRepository], {
      encoding: 'utf8',
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    runGit(source, ['remote', 'add', 'origin', bareRepository]);
    runGit(source, ['push', 'origin', branch]);
    const linkedWorktree = path.join(parent, 'bare-linked');
    runGit(bareRepository, [
      'worktree', 'add', '-b', 'bare-linked-fixture', linkedWorktree, branch
    ]);

    await expect(bindRepository(linkedWorktree, personalSpace)).resolves.toMatchObject({
      bound: true,
      spaceName: 'personal'
    });
    expect(runGit(linkedWorktree, ['rev-parse', '--is-bare-repository'])).toBe('false');
    expect(runGit(bareRepository, ['config', '--local', '--get', 'core.bare'])).toBe('true');

    await unbindRepository(linkedWorktree);
    expect(runGit(linkedWorktree, ['rev-parse', '--show-toplevel']))
      .toBe(await fs.realpath(linkedWorktree));
    expect(runGit(bareRepository, ['rev-parse', '--is-bare-repository'])).toBe('true');
  });

  it('does not activate a dormant config.worktree during bind or after unbind', async () => {
    const parent = await createTemporaryDirectory();
    const repository = await createRepository(parent, 'project');
    runGit(repository, ['config', '--local', 'user.name', 'Original User']);
    runGit(repository, ['config', '--local', 'user.email', 'original@example.com']);
    const gitDirectory = runGit(repository, ['rev-parse', '--absolute-git-dir']);
    const dormantConfig = path.join(gitDirectory, 'config.worktree');
    runGit(repository, [
      'config', '--file', dormantConfig, 'user.email', 'dormant@example.com'
    ]);

    expect(runGit(repository, ['config', 'user.email'])).toBe('original@example.com');
    await bindRepository(repository, personalSpace);
    expect(runGit(repository, ['config', 'user.email'])).toBe('personal@example.com');

    await unbindRepository(repository);
    expect(runGit(repository, ['config', 'user.email'])).toBe('original@example.com');
    expect(runGit(repository, [
      'config', '--file', dormantConfig, '--get', 'user.email'
    ])).toBe('dormant@example.com');
  });

  it.each([
    ['absent', undefined],
    ['false', 'false']
  ])('leaves extensions.worktreeConfig exactly %s after bind and unbind', async (_label, value) => {
    const parent = await createTemporaryDirectory();
    const repository = await createRepository(parent, 'project');
    if (value !== undefined) {
      runGit(repository, ['config', '--local', 'extensions.worktreeConfig', value]);
    }

    const before = readOptionalGitValue(repository, [
      'config', '--local', '--get', 'extensions.worktreeConfig'
    ]);
    await bindRepository(repository, personalSpace);
    await unbindRepository(repository);

    expect(readOptionalGitValue(repository, [
      'config', '--local', '--get', 'extensions.worktreeConfig'
    ])).toBe(before);
  });

  it('continues recursive binding after an individual repository fails', async () => {
    const parent = await createTemporaryDirectory();
    const validRepository = await createRepository(parent, 'valid');
    const invalidRepository = path.join(parent, 'not-a-repository');
    await fs.ensureDir(invalidRepository);

    const result = await bindRepositories(
      [invalidRepository, validRepository],
      personalSpace
    );

    expect(result.successful.map(item => item.repositoryRoot)).toEqual([
      await fs.realpath(validRepository)
    ]);
    expect(result.failed).toEqual([{
      repositoryPath: invalidRepository,
      message: expect.stringContaining('not a git repository')
    }]);
    expect(runGit(validRepository, ['config', 'dss.space'])).toBe('personal');
  });

  it('previews each repository without writing during a dry run', async () => {
    const parent = await createTemporaryDirectory();
    const firstRepository = await createRepository(parent, 'first');
    const secondRepository = await createRepository(parent, 'second');

    const result = await bindRepositories(
      [firstRepository, secondRepository],
      personalSpace,
      { dryRun: true }
    );

    expect(result.successful.map(item => item.repositoryRoot)).toEqual([
      await fs.realpath(firstRepository),
      await fs.realpath(secondRepository)
    ]);
    expect(result.successful).toHaveLength(2);
    expect(result.successful.every(item => item.bound === false)).toBe(true);
    expect(result.failed).toEqual([]);
    await expect(getRepositoryBindingStatus(firstRepository)).resolves.toMatchObject({
      bound: false
    });
    await expect(getRepositoryBindingStatus(secondRepository)).resolves.toMatchObject({
      bound: false
    });
  });

  it('rebinds without duplicating the DSS include', async () => {
    const parent = await createTemporaryDirectory();
    const repository = await createRepository(parent, 'project');
    await bindRepository(repository, personalSpace);
    await bindRepository(repository, workSpace);

    expect(runGit(repository, ['config', 'dss.space'])).toBe('work');
    expect(readGitValues(repository, [
      'config',
      '-z',
      '--local',
      '--get-all',
      await bindingConditionKey(repository)
    ])).toHaveLength(1);
  });

  it('preserves duplicate DSS include ordering while rebinding and removes all on unbind', async () => {
    const parent = await createTemporaryDirectory();
    const repository = await createRepository(parent, 'project');
    const binding = await bindRepository(repository, personalSpace);
    const conditionKey = await bindingConditionKey(repository);
    const unrelatedKey = `includeIf.gitdir:${path.join(parent, 'unrelated.git')}.path`;
    const unrelatedPath = path.join(parent, 'unrelated.config');
    await fs.writeFile(
      unrelatedPath,
      '[user]\n\tname = Precedence User\n\temail = precedence@example.com\n'
    );
    runGit(repository, ['config', '--local', '--add', conditionKey, binding.configPath]);
    runGit(repository, ['config', '--local', '--add', conditionKey, binding.configPath]);
    runGit(repository, ['config', '--local', '--add', conditionKey, unrelatedPath]);
    runGit(repository, ['config', '--local', '--add', unrelatedKey, unrelatedPath]);
    const includesBefore = readGitValues(repository, [
      'config', '-z', '--local', '--get-all', conditionKey
    ]);
    expect(runGit(repository, ['config', 'user.email']))
      .toBe('precedence@example.com');

    await bindRepository(repository, workSpace);
    expect(readGitValues(repository, [
      'config', '-z', '--local', '--get-all', conditionKey
    ])).toEqual(includesBefore);
    expect(runGit(repository, ['config', 'user.email']))
      .toBe('precedence@example.com');
    expect(readGitValues(repository, [
      'config', '-z', '--local', '--get-all', unrelatedKey
    ])).toEqual([unrelatedPath]);

    await unbindRepository(repository);
    expect(readGitValues(repository, [
      'config', '-z', '--local', '--get-all', conditionKey
    ])).toEqual([unrelatedPath]);
    expect(readGitValues(repository, [
      'config', '-z', '--local', '--get-all', unrelatedKey
    ])).toEqual([unrelatedPath]);
  });

  it('rolls back a first bind when final status retrieval fails', async () => {
    const parent = await createTemporaryDirectory();
    const repository = await createRepository(parent, 'project');
    const preview = await bindRepository(repository, personalSpace, { dryRun: true });
    const conditionKey = await bindingConditionKey(repository);
    const localConfigPath = path.join(repository, '.git', 'config');
    const localConfigBefore = await fs.readFile(localConfigPath);
    const restoreGit = await installFinalStatusFailureWrapper(
      parent,
      preview.configPath
    );

    try {
      await expect(bindRepository(repository, personalSpace))
        .rejects.toThrow('simulated status failure');
    } finally {
      restoreGit();
    }

    await expect(fs.readFile(localConfigPath)).resolves.toEqual(localConfigBefore);
    await expect(fs.pathExists(preview.configPath)).resolves.toBe(false);
    await expect(fs.pathExists(path.dirname(preview.configPath))).resolves.toBe(false);
    expect(readGitValues(repository, [
      'config', '-z', '--local', '--get-all', conditionKey
    ])).toEqual([]);
  });

  it('restores an existing binding and interleaved include ordering when final status fails', async () => {
    const parent = await createTemporaryDirectory();
    const repository = await createRepository(parent, 'project');
    const binding = await bindRepository(repository, personalSpace);
    const conditionKey = await bindingConditionKey(repository);
    const unrelatedPath = path.join(parent, 'precedence.config');
    await fs.writeFile(
      unrelatedPath,
      '[user]\n\temail = precedence@example.com\n'
    );
    runGit(repository, ['config', '--local', '--add', conditionKey, binding.configPath]);
    runGit(repository, ['config', '--local', '--add', conditionKey, binding.configPath]);
    runGit(repository, ['config', '--local', '--add', conditionKey, unrelatedPath]);
    const localConfigPath = path.join(repository, '.git', 'config');
    const localConfigBefore = await fs.readFile(localConfigPath);
    const bindingConfigBefore = await fs.readFile(binding.configPath);
    const includesBefore = readGitValues(repository, [
      'config', '-z', '--local', '--get-all', conditionKey
    ]);
    const restoreGit = await installFinalStatusFailureWrapper(
      parent,
      binding.configPath
    );

    try {
      await expect(bindRepository(repository, workSpace))
        .rejects.toThrow('simulated status failure');
    } finally {
      restoreGit();
    }

    await expect(fs.readFile(localConfigPath)).resolves.toEqual(localConfigBefore);
    await expect(fs.readFile(binding.configPath)).resolves.toEqual(bindingConfigBefore);
    expect(readGitValues(repository, [
      'config', '-z', '--local', '--get-all', conditionKey
    ])).toEqual(includesBefore);
    expect(runGit(repository, ['config', 'user.email']))
      .toBe('precedence@example.com');
  });

  it('reports the original status error together with a rollback failure', async () => {
    const parent = await createTemporaryDirectory();
    const repository = await createRepository(parent, 'project');
    const preview = await bindRepository(repository, personalSpace, { dryRun: true });
    const restoreGit = await installFinalStatusFailureWrapper(
      parent,
      preview.configPath,
      true
    );

    try {
      await expect(bindRepository(repository, personalSpace)).rejects.toThrow(
        /simulated status failure.*binding rollback failed.*simulated rollback failure/s
      );
    } finally {
      restoreGit();
    }

    await expect(fs.pathExists(preview.configPath)).resolves.toBe(false);
  });

  it('escapes glob metacharacters in an exact gitdir condition', async () => {
    const parent = await createTemporaryDirectory();
    const repository = await createRepository(parent, 'project[abc]*?');

    const binding = await bindRepository(repository, personalSpace);

    expect(binding).toMatchObject({ bound: true, spaceName: 'personal' });
    expect(runGit(repository, ['config', 'user.email'])).toBe('personal@example.com');
    expect(readGitValues(repository, [
      'config', '-z', '--local', '--get-all', await bindingConditionKey(repository)
    ])).toEqual([binding.configPath]);
    expect(await fs.readFile(path.join(repository, '.git', 'config'), 'utf8'))
      .toContain('project\\\\[abc\\\\]\\\\*\\\\?/.git');

    await expect(unbindRepository(repository)).resolves.toMatchObject({ bound: false });
  });

  it.each([
    ['line feed', '\n'],
    ['carriage return', '\r']
  ])('rejects an explicitly selected repository whose gitdir contains a %s', async (
    _label,
    separator
  ) => {
    const parent = await createTemporaryDirectory();
    const sibling = await createRepository(parent, 'projectline');
    const repository = await createRepository(parent, `project${separator}line`);
    const gitDirectory = runGit(repository, ['rev-parse', '--absolute-git-dir']);
    const sharedConfigBefore = await fs.readFile(path.join(repository, '.git', 'config'));

    await expect(bindRepository(repository, personalSpace, { dryRun: true }))
      .rejects.toThrow(/carriage return or line feed/i);
    await expect(bindRepository(repository, personalSpace))
      .rejects.toThrow(/carriage return or line feed/i);

    await expect(fs.pathExists(path.join(gitDirectory, 'dss'))).resolves.toBe(false);
    await expect(fs.readFile(path.join(repository, '.git', 'config')))
      .resolves.toEqual(sharedConfigBefore);
    expect(readOptionalGitValue(sibling, ['config', 'dss.space'])).toBeUndefined();
  });

  it.each([
    ['line feed', '\n'],
    ['carriage return', '\r']
  ])('rejects a linked-worktree admin dir containing a %s without leaking to a wildcard sibling', async (
    _label,
    separator
  ) => {
    const parent = await createTemporaryDirectory();
    const source = await createRepository(parent, 'source');
    await commitFixture(source);
    const repository = path.join(parent, 'target-worktree');
    const sibling = path.join(parent, 'sibling-worktree');
    runGit(source, ['worktree', 'add', '-b', 'target-fixture', repository]);
    runGit(source, ['worktree', 'add', '-b', 'sibling-fixture', sibling]);
    const gitDirectory = await renameWorktreeGitDirectory(
      repository,
      `slot${separator}line`
    );
    const siblingGitDirectory = await renameWorktreeGitDirectory(sibling, 'slotXline');
    const sharedConfig = path.join(source, '.git', 'config');
    const sharedConfigBefore = await fs.readFile(sharedConfig);

    await expect(bindRepository(repository, personalSpace, { dryRun: true }))
      .rejects.toThrow(/carriage return or line feed/i);
    await expect(bindRepository(repository, personalSpace))
      .rejects.toThrow(/carriage return or line feed/i);

    await expect(fs.readFile(sharedConfig)).resolves.toEqual(sharedConfigBefore);
    await expect(fs.pathExists(path.join(gitDirectory, 'dss'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(siblingGitDirectory, 'dss'))).resolves.toBe(false);
    expect(runGit(sibling, ['config', 'user.email'])).toBe('fixture@example.com');
    expect(readOptionalGitValue(sibling, ['config', 'dss.space'])).toBeUndefined();
  });

  it('reports and removes an exact legacy wildcard binding for a newline gitdir', async () => {
    const parent = await createTemporaryDirectory();
    const repository = await createRepository(parent, 'project\nline');
    const gitDirectory = runGit(repository, ['rev-parse', '--absolute-git-dir']);
    const configPath = path.join(gitDirectory, 'dss', 'config');
    const conditionKey = await bindingConditionKey(repository);
    await fs.ensureDir(path.dirname(configPath));
    await fs.writeFile(
      configPath,
      '[user]\n\tname = Legacy User\n\temail = legacy@example.com\n' +
      '[dss]\n\tspace = legacy\n'
    );
    runGit(repository, [
      'config', '--local', '--add', conditionKey, configPath
    ]);

    await expect(getRepositoryBindingStatus(repository)).resolves.toMatchObject({
      bound: true,
      spaceName: 'legacy',
      email: 'legacy@example.com'
    });
    await expect(unbindRepository(repository)).resolves.toMatchObject({ bound: false });
    expect(readGitValues(repository, [
      'config', '-z', '--local', '--get-all', conditionKey
    ])).toEqual([]);
    await expect(fs.pathExists(configPath)).resolves.toBe(false);
  });

  it('unbinds DSS while preserving prior local values and unrelated includes', async () => {
    const parent = await createTemporaryDirectory();
    const repository = await createRepository(parent, 'project');
    const unrelatedInclude = path.join(parent, 'existing.gitconfig');
    await fs.writeFile(unrelatedInclude, '[color]\n    ui = false\n');
    runGit(repository, ['config', '--local', 'user.name', 'Original User']);
    runGit(repository, ['config', '--local', 'user.email', 'original@example.com']);
    runGit(repository, ['config', '--local', '--add', 'include.path', unrelatedInclude]);

    const bound = await bindRepository(repository, personalSpace);
    const result = await unbindRepository(repository);

    expect(result.bound).toBe(false);
    expect(await fs.pathExists(bound.configPath)).toBe(false);
    expect(runGit(repository, ['config', 'user.name'])).toBe('Original User');
    expect(runGit(repository, ['config', 'user.email'])).toBe('original@example.com');
    expect(runGit(repository, ['config', '--local', '--get-all', 'include.path']))
      .toBe(unrelatedInclude);
  });

  it('reports effective Git identity for an unbound repository', async () => {
    const parent = await createTemporaryDirectory();
    const repository = await createRepository(parent, 'project');
    runGit(repository, ['config', '--local', 'user.name', 'Existing User']);
    runGit(repository, ['config', '--local', 'user.email', 'existing@example.com']);
    runGit(repository, ['config', '--local', 'core.sshCommand', 'ssh -i /tmp/existing-key']);

    await expect(getRepositoryBindingStatus(repository)).resolves.toMatchObject({
      bound: false,
      userName: 'Existing User',
      email: 'existing@example.com',
      sshCommand: 'ssh -i /tmp/existing-key'
    });
  });

  it('does not mutate repository config during a dry run', async () => {
    const parent = await createTemporaryDirectory();
    const repository = await createRepository(parent, 'project');
    const before = await fs.readFile(path.join(repository, '.git', 'config'), 'utf8');

    const status = await bindRepository(repository, personalSpace, { dryRun: true });

    expect(status).toMatchObject({
      bound: false,
      spaceName: personalSpace.name,
      userName: personalSpace.userName,
      email: personalSpace.email,
      sshCommand: "ssh -i '/tmp/DSS keys/key '\\''$HOME; touch blocked'\\''' -o IdentitiesOnly=yes"
    });
    expect(await fs.readFile(path.join(repository, '.git', 'config'), 'utf8')).toBe(before);
    await expect(fs.pathExists(status.configPath)).resolves.toBe(false);
    await expect(fs.pathExists(path.dirname(status.configPath))).resolves.toBe(false);
    await expect(getRepositoryBindingStatus(repository)).resolves.toMatchObject({ bound: false });
  });

  it('rejects bind on unsupported Git without leaving file or config state', async () => {
    const parent = await createTemporaryDirectory();
    const repository = await createRepository(parent, 'project');
    const gitDirectory = runGit(repository, ['rev-parse', '--absolute-git-dir']);
    const configPath = path.join(gitDirectory, 'dss', 'config');
    const localConfigPath = path.join(gitDirectory, 'config');
    const localConfigBefore = await fs.readFile(localConfigPath);
    const restoreGit = await installGitVersionWrapper(parent, 'git version 2.29.9');

    try {
      await expect(bindRepository(repository, personalSpace, { dryRun: true }))
        .rejects.toThrow(/Git 2\.30 or newer/i);
      await expect(bindRepository(repository, personalSpace))
        .rejects.toThrow(/Git 2\.30 or newer/i);
      await expect(getRepositoryBindingStatus(repository)).resolves.toMatchObject({
        bound: false
      });
    } finally {
      restoreGit();
    }

    await expect(fs.readFile(localConfigPath)).resolves.toEqual(localConfigBefore);
    await expect(fs.pathExists(configPath)).resolves.toBe(false);
    await expect(fs.pathExists(path.dirname(configPath))).resolves.toBe(false);
  });

  it('rejects unbind on unsupported Git without changing an existing binding', async () => {
    const parent = await createTemporaryDirectory();
    const repository = await createRepository(parent, 'project');
    const binding = await bindRepository(repository, personalSpace);
    const localConfigPath = path.join(repository, '.git', 'config');
    const localConfigBefore = await fs.readFile(localConfigPath);
    const bindingConfigBefore = await fs.readFile(binding.configPath);
    const restoreGit = await installGitVersionWrapper(parent, 'git version 2.29.9');

    try {
      await expect(unbindRepository(repository, { dryRun: true })).resolves.toMatchObject({
        bound: true,
        spaceName: 'personal'
      });
      await expect(unbindRepository(repository))
        .rejects.toThrow(/Git 2\.30 or newer/i);
      await expect(getRepositoryBindingStatus(repository)).resolves.toMatchObject({
        bound: true,
        spaceName: 'personal'
      });
    } finally {
      restoreGit();
    }

    await expect(fs.readFile(localConfigPath)).resolves.toEqual(localConfigBefore);
    await expect(fs.readFile(binding.configPath)).resolves.toEqual(bindingConfigBefore);
  });

  it('keeps the DSS config outside the repository index', async () => {
    const parent = await createTemporaryDirectory();
    const repository = await createRepository(parent, 'project');
    await fs.writeFile(path.join(repository, 'README.md'), 'tracked fixture\n');

    const binding = await bindRepository(repository, personalSpace);
    runGit(repository, ['add', '--all']);

    expect(await fs.pathExists(binding.configPath)).toBe(true);
    expect(runGit(repository, ['ls-files']).split('\n')).toEqual(['README.md']);
  });

  it('unbinds idempotently', async () => {
    const parent = await createTemporaryDirectory();
    const repository = await createRepository(parent, 'project');

    await bindRepository(repository, personalSpace);
    const first = await unbindRepository(repository);
    const second = await unbindRepository(repository);

    expect(first.bound).toBe(false);
    expect(second.bound).toBe(false);
  });

  it('preserves global user config through binding lifecycle', async () => {
    const parent = await createTemporaryDirectory();
    const repository = await createRepository(parent, 'project');
    const beforeName = readOptionalGlobalGitConfig('user.name');
    const beforeEmail = readOptionalGlobalGitConfig('user.email');

    await bindRepository(repository, personalSpace);
    await unbindRepository(repository);

    expect(readOptionalGlobalGitConfig('user.name')).toBe(beforeName);
    expect(readOptionalGlobalGitConfig('user.email')).toBe(beforeEmail);
  });

  it('rejects a symlinked DSS directory without writing or deleting external config', async () => {
    const parent = await createTemporaryDirectory();
    const repository = await createRepository(parent, 'project');
    const externalDirectory = path.join(parent, 'external-dss');
    const externalConfig = path.join(externalDirectory, 'config');
    const dssDirectory = path.join(repository, '.git', 'dss');
    const expectedConfigPath = path.join(dssDirectory, 'config');
    await fs.ensureDir(externalDirectory);
    await fs.symlink(externalDirectory, dssDirectory);

    await expect(bindRepository(repository, personalSpace)).rejects.toThrow(/symbolic link/i);
    await expect(fs.pathExists(externalConfig)).resolves.toBe(false);

    await fs.writeFile(externalConfig, '[dss]\n    space = external\n');
    runGit(repository, [
      'config',
      '--local',
      '--add',
      await bindingConditionKey(repository),
      expectedConfigPath
    ]);

    await expect(unbindRepository(repository)).rejects.toThrow(/symbolic link/i);
    await expect(fs.readFile(externalConfig, 'utf8')).resolves.toBe(
      '[dss]\n    space = external\n'
    );
  });

  it('removes a newly written DSS file when conditional include registration fails', async () => {
    const parent = await createTemporaryDirectory();
    const repository = await createRepository(parent, 'project');
    const preview = await bindRepository(repository, personalSpace, { dryRun: true });
    const conditionKey = await bindingConditionKey(repository);
    const gitWrapperDirectory = path.join(parent, 'git-wrapper-registration');
    const gitWrapper = path.join(gitWrapperDirectory, 'git');
    const gitExecutable = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const originalPath = process.env.PATH;
    const originalGitExecutable = process.env.DSS_TEST_REAL_GIT;
    await fs.ensureDir(gitWrapperDirectory);
    await fs.writeFile(
      gitWrapper,
      [
        '#!/usr/bin/env node',
        "const { execFileSync } = require('child_process');",
        'const args = process.argv.slice(2);',
        "const configIndex = args.indexOf('config');",
        "const key = args[configIndex + 3] || '';",
        "if (args[configIndex + 1] === '--local' && args[configIndex + 2] === '--add' && key.startsWith('includeIf.gitdir:')) {",
        "  process.stderr.write('simulated registration failure\\n');",
        '  process.exit(2);',
        '}',
        "execFileSync(process.env.DSS_TEST_REAL_GIT, args, { stdio: 'inherit' });",
        ''
      ].join('\n')
    );
    await fs.chmod(gitWrapper, 0o755);
    process.env.DSS_TEST_REAL_GIT = gitExecutable;
    process.env.PATH = `${gitWrapperDirectory}${path.delimiter}${originalPath ?? ''}`;

    try {
      await expect(bindRepository(repository, personalSpace))
        .rejects.toThrow('simulated registration failure');
      await expect(fs.pathExists(preview.configPath)).resolves.toBe(false);
      await expect(fs.pathExists(path.dirname(preview.configPath))).resolves.toBe(false);
      expect(readGitValues(repository, [
        'config', '-z', '--local', '--get-all', conditionKey
      ])).toEqual([]);
      expect(readOptionalGitValue(repository, [
        'config', '--local', '--get', 'extensions.worktreeConfig'
      ])).toBeUndefined();
    } finally {
      process.env.PATH = originalPath;
      if (originalGitExecutable === undefined) {
        delete process.env.DSS_TEST_REAL_GIT;
      } else {
        process.env.DSS_TEST_REAL_GIT = originalGitExecutable;
      }
    }
  });

  it('preserves the DSS config when the local include read fails', async () => {
    const parent = await createTemporaryDirectory();
    const repository = await createRepository(parent, 'project');
    const binding = await bindRepository(repository, personalSpace);
    const conditionKey = await bindingConditionKey(repository);
    const gitWrapperDirectory = path.join(parent, 'git-wrapper');
    const gitWrapper = path.join(gitWrapperDirectory, 'git');
    const gitExecutable = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const originalPath = process.env.PATH;
    const originalGitExecutable = process.env.DSS_TEST_REAL_GIT;
    await fs.ensureDir(gitWrapperDirectory);
    await fs.writeFile(
      gitWrapper,
      [
        '#!/usr/bin/env node',
        "const { execFileSync } = require('child_process');",
        'const args = process.argv.slice(2);',
        "const configIndex = args.indexOf('config');",
        "const key = args[configIndex + 4] || '';",
        "if (args.slice(configIndex, configIndex + 4).join(' ') === 'config -z --local --get-all' && key.startsWith('includeIf.gitdir:')) {",
        "  process.stderr.write('simulated config failure\\n');",
        '  process.exit(2);',
        '}',
        "execFileSync(process.env.DSS_TEST_REAL_GIT, args, { stdio: 'inherit' });",
        ''
      ].join('\n')
    );
    await fs.chmod(gitWrapper, 0o755);
    process.env.DSS_TEST_REAL_GIT = gitExecutable;
    process.env.PATH = `${gitWrapperDirectory}${path.delimiter}${originalPath ?? ''}`;

    try {
      expect(execFileSync('which', ['git'], { encoding: 'utf8', env: process.env }).trim())
        .toBe(gitWrapper);
      expect(() => runGit(repository, [
        'config',
        '-z',
        '--local',
        '--get-all',
        conditionKey
      ]))
        .toThrow('simulated config failure');
      await expect(unbindRepository(repository)).rejects.toThrow('simulated config failure');
      await expect(fs.pathExists(binding.configPath)).resolves.toBe(true);
    } finally {
      process.env.PATH = originalPath;
      if (originalGitExecutable === undefined) {
        delete process.env.DSS_TEST_REAL_GIT;
      } else {
        process.env.DSS_TEST_REAL_GIT = originalGitExecutable;
      }
    }
  });
});
