import { execFileSync } from 'child_process';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import {
  bindRepository,
  bindRepositories,
  discoverRepositories,
  getRepositoryBindingStatus,
  unbindRepository,
  resolveRepositoryRoot
} from '../../src/utils/repoBinding';
import { ISpace } from '../../src/utils/types';

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
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

  it('resolves the repository root from a nested working directory', async () => {
    const parent = await createTemporaryDirectory();
    const repository = await createRepository(parent, 'project');
    const nestedDirectory = path.join(repository, 'src', 'features');
    await fs.ensureDir(nestedDirectory);

    await expect(resolveRepositoryRoot(nestedDirectory)).resolves.toBe(
      await fs.realpath(repository)
    );
  });

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
    const includes = runGit(repository, ['config', '--worktree', '--get-all', 'include.path'])
      .split('\n')
      .filter(Boolean);

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
    runGit(repository, ['config', 'user.name', 'Fixture User']);
    runGit(repository, ['config', 'user.email', 'fixture@example.com']);
    await fs.writeFile(path.join(repository, 'README.md'), 'fixture\n');
    runGit(repository, ['add', 'README.md']);
    runGit(repository, ['commit', '-m', 'fixture']);
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
    expect(runGit(repository, ['config', '--worktree', '--get-all', 'include.path']).split('\n'))
      .toHaveLength(1);
  });

  it('binds, rebinds, reports, and unbinds a repository whose path contains a newline', async () => {
    const parent = await createTemporaryDirectory();
    const repository = await createRepository(parent, 'project\nline');

    const first = await bindRepository(repository, personalSpace);
    expect(first).toMatchObject({ bound: true, spaceName: 'personal' });

    const rebound = await bindRepository(repository, workSpace);
    expect(rebound).toMatchObject({ bound: true, spaceName: 'work' });
    expect(runGit(repository, ['config', 'user.email'])).toBe('work@example.com');
    expect(readGitValues(repository, [
      'config',
      '-z',
      '--worktree',
      '--get-all',
      'include.path'
    ])).toEqual([rebound.configPath]);

    const unbound = await unbindRepository(repository);
    expect(unbound.bound).toBe(false);
    expect(readGitValues(repository, [
      'config',
      '-z',
      '--worktree',
      '--get-all',
      'include.path'
    ])).toEqual([]);
    await expect(fs.pathExists(rebound.configPath)).resolves.toBe(false);
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
    runGit(repository, ['config', '--local', '--add', 'include.path', expectedConfigPath]);

    await expect(unbindRepository(repository)).rejects.toThrow(/symbolic link/i);
    await expect(fs.readFile(externalConfig, 'utf8')).resolves.toBe(
      '[dss]\n    space = external\n'
    );
  });

  it('preserves the DSS config when the local include read fails', async () => {
    const parent = await createTemporaryDirectory();
    const repository = await createRepository(parent, 'project');
    const binding = await bindRepository(repository, personalSpace);
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
        "if (args.slice(-5).join(' ') === 'config -z --worktree --get-all include.path') {",
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
        '--worktree',
        '--get-all',
        'include.path'
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
