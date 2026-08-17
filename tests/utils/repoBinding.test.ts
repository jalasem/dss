import { execFileSync } from 'child_process';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import {
  discoverRepositories,
  resolveRepositoryRoot
} from '../../src/utils/repoBinding';

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

async function createRepository(parent: string, name: string): Promise<string> {
  const repository = path.join(parent, name);
  await fs.ensureDir(repository);
  runGit(repository, ['init']);
  return repository;
}

describe('repository targeting', () => {
  const temporaryDirectories: string[] = [];

  async function createTemporaryDirectory(): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-binding-'));
    temporaryDirectories.push(directory);
    return directory;
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
});
