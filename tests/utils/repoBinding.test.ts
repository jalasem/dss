import { execFileSync } from 'child_process';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import {
  bindRepository,
  discoverRepositories,
  getRepositoryBindingStatus,
  unbindRepository,
  resolveRepositoryRoot
} from '../../src/utils/repoBinding';
import { ISpace } from '../../src/utils/types';

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
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
    const includes = runGit(repository, ['config', '--local', '--get-all', 'include.path'])
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

  it('rebinds without duplicating the DSS include', async () => {
    const parent = await createTemporaryDirectory();
    const repository = await createRepository(parent, 'project');
    const workSpace: ISpace = {
      name: 'work',
      email: 'work@example.com',
      userName: 'Work User',
      sshKeyPath: '/tmp/work-key'
    };

    await bindRepository(repository, personalSpace);
    await bindRepository(repository, workSpace);

    expect(runGit(repository, ['config', 'dss.space'])).toBe('work');
    expect(runGit(repository, ['config', '--local', '--get-all', 'include.path']).split('\n'))
      .toHaveLength(1);
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
    await expect(getRepositoryBindingStatus(repository)).resolves.toMatchObject({ bound: false });
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
});
