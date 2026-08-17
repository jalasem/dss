# Repository-Local Space Binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persistent, repository-local DSS identities that work in VS Code and other editors without changing global Git or SSH state.

**Architecture:** A new repository-binding module uses Git's argument-based config commands and a DSS-owned include file under each repository's Git directory. A separate command module resolves spaces and CLI options, while recursive discovery and batch execution remain reusable and independently tested with temporary real Git repositories.

**Tech Stack:** TypeScript 5, Node.js child processes, fs-extra, Commander 12, Inquirer prompts, Jest 30 with ts-jest, Git CLI.

**Spec:** `docs/superpowers/specs/2026-08-17-repo-local-space-binding-design.md`

## Global Constraints

- Existing `dss switch` behavior remains unchanged.
- Binding must never call `git config --global`, `ssh-add`, or modify `~/.ssh/config`.
- Binding data must remain beneath the repository Git directory and must not be trackable or pushable.
- Git commands must use `execFile` argument arrays with no shell interpolation.
- `--recursive [parentPath]` and `-r [parentPath]` default to `process.cwd()` when the path is omitted.
- `--path` and `--recursive` are mutually exclusive.
- Existing unrelated local Git configuration and `include.path` entries must survive bind and unbind.
- Every production behavior is implemented only after its focused test has failed for the expected reason.

---

### Task 1: Repository Resolution and Recursive Discovery

**Files:**
- Create: `src/utils/repoBinding.ts`
- Create: `tests/utils/repoBinding.test.ts`

**Interfaces:**
- Produces: `resolveRepositoryRoot(startPath: string): Promise<string>`
- Produces: `discoverRepositories(parentPath: string): Promise<string[]>`
- Consumes: `git` executable and local filesystem paths only

- [ ] **Step 1: Write test helpers that create real temporary Git repositories**

Add the following foundation to `tests/utils/repoBinding.test.ts`:

```typescript
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
});
```

- [ ] **Step 2: Write a failing test for resolving a repository from a nested directory**

Inside the describe block, add:

```typescript
it('resolves the repository root from a nested working directory', async () => {
  const parent = await createTemporaryDirectory();
  const repository = await createRepository(parent, 'project');
  const nestedDirectory = path.join(repository, 'src', 'features');
  await fs.ensureDir(nestedDirectory);

  await expect(resolveRepositoryRoot(nestedDirectory)).resolves.toBe(
    await fs.realpath(repository)
  );
});
```

- [ ] **Step 3: Run the focused test and confirm RED**

Run: `npm test -- --runInBand tests/utils/repoBinding.test.ts -t "resolves the repository root"`

Expected: FAIL because `src/utils/repoBinding.ts` or `resolveRepositoryRoot` does not exist.

- [ ] **Step 4: Implement argument-safe Git execution and root resolution**

Create `src/utils/repoBinding.ts` with:

```typescript
import { execFile } from 'child_process';
import fs from 'fs-extra';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    encoding: 'utf8'
  });
  return stdout.trim();
}

export async function resolveRepositoryRoot(startPath: string): Promise<string> {
  const requestedPath = path.resolve(startPath);
  const repositoryRoot = await runGit(requestedPath, ['rev-parse', '--show-toplevel']);
  return fs.realpath(repositoryRoot);
}
```

- [ ] **Step 5: Run the focused test and confirm GREEN**

Run: `npm test -- --runInBand tests/utils/repoBinding.test.ts -t "resolves the repository root"`

Expected: PASS.

- [ ] **Step 6: Write failing discovery tests for normal repositories, linked worktrees, exclusions, ordering, and symlinks**

Add tests that create two normal repositories, a linked worktree whose `.git`
entry is a file, a repository beneath `node_modules`, and a symlink to an
external repository. Configure and commit one file in the linked-worktree
source before calling `git worktree add`. Assert the literal sorted result:

```typescript
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

  expect(repositories).toEqual([
    await fs.realpath(alpha),
    await fs.realpath(linked),
    await fs.realpath(source)
  ].sort());
  expect(repositories).not.toContain(await fs.realpath(ignored));
  expect(repositories).not.toContain(await fs.realpath(external));
});
```

- [ ] **Step 7: Run discovery tests and confirm RED**

Run: `npm test -- --runInBand tests/utils/repoBinding.test.ts -t "discovers repositories"`

Expected: FAIL because `discoverRepositories` is not exported.

- [ ] **Step 8: Implement recursive discovery**

Add to `src/utils/repoBinding.ts`:

```typescript
const EXCLUDED_DIRECTORIES = new Set(['.git', 'node_modules']);

export async function discoverRepositories(parentPath: string): Promise<string[]> {
  const parent = path.resolve(parentPath);
  const parentStats = await fs.stat(parent);
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
        // A stale .git marker is not a usable repository.
      }
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
      await walk(path.join(directory, entry.name));
    }
  }

  await walk(parent);
  return [...repositories].sort((left, right) => left.localeCompare(right));
}
```

- [ ] **Step 9: Run the complete targeting tests and confirm GREEN**

Run: `npm test -- --runInBand tests/utils/repoBinding.test.ts`

Expected: all repository targeting tests PASS.

- [ ] **Step 10: Commit repository targeting**

```bash
git add src/utils/repoBinding.ts tests/utils/repoBinding.test.ts
git commit -m "feat: discover repositories for local binding"
```

---

### Task 2: Reversible Repository Binding Lifecycle

**Files:**
- Modify: `src/utils/repoBinding.ts`
- Modify: `tests/utils/repoBinding.test.ts`

**Interfaces:**
- Consumes: `ISpace` from `src/utils/types.ts`
- Produces: `bindRepository(repositoryPath: string, space: ISpace, options?: { dryRun?: boolean }): Promise<RepositoryBindingStatus>`
- Produces: `unbindRepository(repositoryPath: string, options?: { dryRun?: boolean }): Promise<RepositoryBindingStatus>`
- Produces: `getRepositoryBindingStatus(repositoryPath: string): Promise<RepositoryBindingStatus>`
- Produces: `RepositoryBindingStatus`

- [ ] **Step 1: Write failing tests for binding and effective identity**

Extend the test imports with the lifecycle functions and `ISpace`. Create a
literal fixture whose key path includes whitespace and shell metacharacters:

```typescript
const personalSpace: ISpace = {
  name: 'personal',
  email: 'personal@example.com',
  userName: 'Personal User',
  sshKeyPath: "/tmp/DSS keys/key '$HOME; touch blocked'"
};

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
```

- [ ] **Step 2: Run the focused binding test and confirm RED**

Run: `npm test -- --runInBand tests/utils/repoBinding.test.ts -t "binds one repository"`

Expected: FAIL because the binding lifecycle API does not exist.

- [ ] **Step 3: Implement status types, config-path resolution, and safe SSH path quoting**

Add to `src/utils/repoBinding.ts`:

```typescript
import { ISpace } from './types';

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
```

- [ ] **Step 4: Implement atomic include-file creation and status reading**

Add these functions:

```typescript
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
    await runGit(directory, ['config', '--file', temporaryPath, 'core.sshCommand', buildSshCommand(space.sshKeyPath)]);
    await runGit(directory, ['config', '--file', temporaryPath, 'dss.space', space.name]);
    await fs.move(temporaryPath, configPath, { overwrite: true });
  } catch (error) {
    await fs.remove(temporaryPath);
    throw error;
  }
}

export async function getRepositoryBindingStatus(
  repositoryPath: string
): Promise<RepositoryBindingStatus> {
  const repositoryRoot = await resolveRepositoryRoot(repositoryPath);
  const configPath = await resolveBindingConfigPath(repositoryRoot);
  const includes = await getLocalIncludes(repositoryRoot);
  const bound = includes.includes(configPath) && await fs.pathExists(configPath);

  if (!bound) return { repositoryRoot, configPath, bound: false };

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
```

- [ ] **Step 5: Implement binding and confirm GREEN**

```typescript
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
```

Run: `npm test -- --runInBand tests/utils/repoBinding.test.ts -t "binds one repository"`

Expected: PASS.

- [ ] **Step 6: Write failing tests for rebinding, dry-run, unbinding, idempotency, unrelated includes, and global-config preservation**

Add focused tests with these literal assertions:

```typescript
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

  await bindRepository(repository, personalSpace, { dryRun: true });

  expect(await fs.readFile(path.join(repository, '.git', 'config'), 'utf8')).toBe(before);
  await expect(getRepositoryBindingStatus(repository)).resolves.toMatchObject({ bound: false });
});
```

For global preservation, read `git config --global --get user.name` and
`user.email` with a helper that permits absent values, bind and unbind, and
assert the before and after literals are equal. For idempotency, call
`unbindRepository` twice and assert both returned statuses are unbound.

- [ ] **Step 7: Run lifecycle tests and confirm RED**

Run: `npm test -- --runInBand tests/utils/repoBinding.test.ts -t "rebinds|unbinds|dry run|global"`

Expected: FAIL because `unbindRepository` is missing and lifecycle cases are incomplete.

- [ ] **Step 8: Implement exact include removal and idempotent unbinding**

```typescript
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
      'config', '--local', '--fixed-value', '--unset-all', 'include.path', configPath
    ]);
  }
  await fs.remove(configPath);
  return getRepositoryBindingStatus(repositoryRoot);
}
```

- [ ] **Step 9: Run lifecycle tests and the existing suite**

Run: `npm test -- --runInBand tests/utils/repoBinding.test.ts`

Expected: all lifecycle and targeting tests PASS.

Run: `npm test -- --runInBand`

Expected: 7 existing suites plus the new suite PASS.

- [ ] **Step 10: Commit the binding lifecycle**

```bash
git add src/utils/repoBinding.ts tests/utils/repoBinding.test.ts
git commit -m "feat: add reversible repository-local binding"
```

---

### Task 3: Batch Binding With Per-Repository Results

**Files:**
- Modify: `src/utils/repoBinding.ts`
- Modify: `tests/utils/repoBinding.test.ts`

**Interfaces:**
- Consumes: `bindRepository`, `ISpace`, repository path list
- Produces: `bindRepositories(repositoryPaths: string[], space: ISpace, options?: { dryRun?: boolean }): Promise<BatchBindingResult>`
- Produces: `BatchBindingResult` with `successful` statuses and `{ repositoryPath, message }` failures

- [ ] **Step 1: Write a failing test proving one failure does not stop later repositories**

```typescript
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
```

- [ ] **Step 2: Run the batch test and confirm RED**

Run: `npm test -- --runInBand tests/utils/repoBinding.test.ts -t "continues recursive binding"`

Expected: FAIL because `bindRepositories` does not exist.

- [ ] **Step 3: Implement sequential batch binding and normalized errors**

```typescript
export interface BatchBindingFailure {
  repositoryPath: string;
  message: string;
}

export interface BatchBindingResult {
  successful: RepositoryBindingStatus[];
  failed: BatchBindingFailure[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
```

- [ ] **Step 4: Run the batch test and confirm GREEN**

Run: `npm test -- --runInBand tests/utils/repoBinding.test.ts -t "continues recursive binding"`

Expected: PASS.

- [ ] **Step 5: Add and pass a batch dry-run test**

Create two repositories, call `bindRepositories` with `{ dryRun: true }`,
assert two successful previews and zero failures, then assert both repositories
remain unbound through `getRepositoryBindingStatus`.

Run: `npm test -- --runInBand tests/utils/repoBinding.test.ts`

Expected: all repository-binding tests PASS.

- [ ] **Step 6: Commit batch binding**

```bash
git add src/utils/repoBinding.ts tests/utils/repoBinding.test.ts
git commit -m "feat: bind repository groups independently"
```

---

### Task 4: Bind, Unbind, and Status CLI Commands

**Files:**
- Create: `src/utils/repoBindingCommands.ts`
- Modify: `src/index.ts`
- Create: `tests/repoBindingCli.test.ts`

**Interfaces:**
- Consumes: repository-binding interfaces from Task 2 and Task 3
- Produces: `bindSpaceToRepository(spaceName?: string, options?: BindCommandOptions): Promise<void>`
- Produces: `unbindSpaceFromRepository(options?: RepositoryCommandOptions): Promise<void>`
- Produces: `showRepositoryBindingStatus(options?: RepositoryCommandOptions): Promise<void>`
- Produces: Commander commands `bind`, `unbind`, and `status`

- [ ] **Step 1: Write spawned CLI tests for help and single-repository binding**

Create `tests/repoBindingCli.test.ts` using `execFileSync` rather than shell
strings. In `beforeAll`, run `npm run build`. For each test, create a temporary
HOME containing `.dss/spaces/config.json` with a complete `personal` space and
a real Git repository. Assert:

```typescript
it('registers repository binding commands', () => {
  const output = runCli(['--help']);
  expect(output).toContain('bind');
  expect(output).toContain('unbind');
  expect(output).toContain('status');
});

it('binds an explicit repository path without changing the process working directory', () => {
  const output = runCli(['bind', 'personal', '--path', repository]);
  expect(output).toContain('personal');
  expect(runGit(repository, ['config', 'user.email'])).toBe('personal@example.com');
  expect(runGit(repository, ['config', 'dss.space'])).toBe('personal');
});
```

Write a temporary CommonJS preload that replaces `os.homedir()` with the test
home before DSS modules load. Implement `runCli` as:

```typescript
function runCli(args: string[], cwd: string = temporaryHome): string {
  return execFileSync(process.execPath, ['--require', homedirPreloadPath, CLI_PATH, ...args], {
    cwd,
    encoding: 'utf8'
  });
}
```

Create `homedirPreloadPath` inside the test's temporary directory with this
literal module body, substituting `temporaryHome` through `JSON.stringify`:

```typescript
await fs.writeFile(
  homedirPreloadPath,
  `const os = require('os'); os.homedir = () => ${JSON.stringify(temporaryHome)};\n`
);
```

- [ ] **Step 2: Run CLI tests and confirm RED**

Run: `npm test -- --runInBand tests/repoBindingCli.test.ts`

Expected: FAIL because the commands are not registered.

- [ ] **Step 3: Implement space selection and single-repository command handlers**

Create `src/utils/repoBindingCommands.ts` with option types:

```typescript
import { confirm, select } from '@inquirer/prompts';
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
  const config: IConfig = await fs.readJson(configPath);
  if (config.spaces.length === 0) return undefined;
  const selectedName = spaceName || await select({
    message: 'Choose a space to bind:',
    choices: config.spaces.map(space => ({
      name: space.name,
      value: space.name,
      description: `${space.email} (${space.userName})`
    }))
  });
  return config.spaces.find(space => space.name === selectedName);
}

function printStatus(status: RepositoryBindingStatus): void {
  UIHelper.printStatus('Repository', status.repositoryRoot, 'info');
  UIHelper.printStatus('Binding', status.spaceName || 'Not bound', status.bound ? 'success' : 'info');
  if (status.userName) UIHelper.printStatus('Git User', status.userName, 'info');
  if (status.email) UIHelper.printStatus('Git Email', status.email, 'info');
  if (status.sshCommand) UIHelper.printStatus('SSH Command', status.sshCommand, 'info');
}
```

Add these handlers so option validation, current-directory defaults, dry-run
behavior, confirmation, and partial failures are explicit:

```typescript
function fail(message: string): void {
  UIHelper.error(message);
  process.exitCode = 1;
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
    if (!space.sshKeyPath.trim()) {
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
      const approved = await confirm({
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
    if (options.dryRun) UIHelper.info('Dry run: the existing binding would be removed.');
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
```

- [ ] **Step 4: Register the three commands in `src/index.ts`**

Import the handlers and add:

```typescript
program
  .command('bind [spaceName]')
  .description('Bind a space to one or more Git repositories')
  .option('-p, --path <repositoryPath>', 'Bind an explicit Git repository')
  .option('-r, --recursive [parentPath]', 'Bind repositories beneath a parent directory')
  .option('--dry-run', 'Preview changes without applying them')
  .action(bindSpaceToRepository);

program
  .command('unbind')
  .description('Remove the DSS binding from a Git repository')
  .option('-p, --path <repositoryPath>', 'Select an explicit Git repository')
  .option('--dry-run', 'Preview changes without applying them')
  .action(unbindSpaceFromRepository);

program
  .command('status')
  .description('Show repository-local DSS binding status')
  .option('-p, --path <repositoryPath>', 'Select an explicit Git repository')
  .action(showRepositoryBindingStatus);
```

- [ ] **Step 5: Run single-repository CLI tests and confirm GREEN**

Run: `npm test -- --runInBand tests/repoBindingCli.test.ts -t "registers|binds an explicit"`

Expected: PASS.

- [ ] **Step 6: Write failing CLI tests for current-directory recursion, dry-run, status, unbind, and conflicting options**

Add tests that:

- Run `bind personal -r --dry-run` with the parent directory as `cwd`, assert
  both repository paths are printed, and assert neither is bound.
- Bind a repository, run `status --path ${repository}`, and assert the output
  contains `personal@example.com` and `personal`.
- Bind and then run `unbind --path ${repository}`, asserting `dss.space` is no
  longer readable.
- Spawn `bind personal --path ${repository} -r` and assert a non-zero exit code
  plus an error mentioning mutually exclusive options.

Run: `npm test -- --runInBand tests/repoBindingCli.test.ts -t "recursive|status|unbind|mutually"`

Expected: FAIL until recursive flow, dry-run output, and validation are complete.

- [ ] **Step 7: Complete recursive confirmation and result reporting**

Make any corrections exposed by the new tests in the exact handlers from Step
3. Keep the recursive default as `process.cwd()`, skip confirmation only during
dry-run, and preserve the final success/failure summary.

- [ ] **Step 8: Run CLI tests, build, and the full suite**

Run: `npm test -- --runInBand tests/repoBindingCli.test.ts`

Expected: all repository-binding CLI tests PASS.

Run: `npm run build`

Expected: TypeScript compilation exits 0.

Run: `npm test -- --runInBand`

Expected: all existing and new suites PASS.

- [ ] **Step 9: Commit the CLI commands**

```bash
git add src/index.ts src/utils/repoBindingCommands.ts tests/repoBindingCli.test.ts
git commit -m "feat: expose repository-local binding commands"
```

---

### Task 5: Completion Scripts and User Documentation

**Files:**
- Modify: `src/utils/completion.ts`
- Create: `tests/utils/completion.test.ts`
- Modify: `README.MD`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: final command syntax from Task 4
- Produces: Bash, Zsh, and Fish completion entries for `bind`, `unbind`, and `status`
- Produces: README workflows for VS Code, explicit paths, recursive current-directory binding, status, and unbind

- [ ] **Step 1: Write failing completion-output tests**

Mock `confirm` to resolve `false`, spy on `console.log`, and call the existing
public `generateCompletionScript` for Bash, Zsh, and Fish. Join the captured
console output and assert each generated script contains all three new commands
and that Bash/Fish outputs contain `--path`, `--recursive`, and `--dry-run` for
`bind`. This exercises the public behavior without exporting a private helper.

Run: `npm test -- --runInBand tests/utils/completion.test.ts`

Expected: FAIL because the generated scripts lack the new commands and options.

- [ ] **Step 2: Update all completion generators and confirm GREEN**

Add `bind unbind status` to Bash `opts`, Zsh `commands`, and Fish command
entries. Include `bind` among commands that complete DSS space names. Add the
documented command options for each shell without changing existing completion
behavior.

Run: `npm test -- --runInBand tests/utils/completion.test.ts`

Expected: PASS.

- [ ] **Step 3: Add concise default-help suggestions**

In `src/index.ts`, add these suggestions to the no-command help block:

```typescript
console.log(UIHelper.dim('  • ' + UIHelper.command('dss bind <space>') + ' - Bind the current Git repository'));
console.log(UIHelper.dim('  • ' + UIHelper.command('dss status') + ' - Show this repository binding'));
```

- [ ] **Step 4: Document the repository-local workflow in `README.MD`**

Add a `Repository-Local Binding` section near Core Commands with these exact
working examples:

```bash
# From a repository opened in VS Code
dss bind aweds-personal

# Bind an explicitly selected repository
dss bind aweds-personal --path ~/Desktop/my-project

# From a parent folder, preview and bind every child Git repository
dss bind aweds-personal -r --dry-run
dss bind aweds-personal -r

# Inspect or remove the current repository binding
dss status
dss unbind
```

State plainly that DSS stores the binding under `.git/`, no binding file can be
committed or pushed, editor Git integrations inherit the binding, and `dss
switch` remains the separate global mode.

- [ ] **Step 5: Run documentation-adjacent tests, build, and diff checks**

Run: `npm test -- --runInBand tests/utils/completion.test.ts tests/cli.test.ts tests/repoBindingCli.test.ts`

Expected: all selected suites PASS.

Run: `npm run build`

Expected: exit 0.

Run: `git diff --check`

Expected: no output and exit 0.

- [ ] **Step 6: Commit completions and documentation**

```bash
git add README.MD src/index.ts src/utils/completion.ts tests/utils/completion.test.ts
git commit -m "docs: explain editor-friendly repository binding"
```

---

### Task 6: Final Verification and Manual Smoke Test

**Files:**
- Verify only; modify files solely when a failing check reveals a defect, and add a failing regression test before fixing that defect.

**Interfaces:**
- Consumes: completed feature branch
- Produces: verification evidence suitable for the pull-request description

- [ ] **Step 1: Run the full Jest suite**

Run: `npm test -- --runInBand`

Expected: every suite and test PASS with zero failures.

- [ ] **Step 2: Run the production TypeScript build**

Run: `npm run build`

Expected: exit 0 and generated output under ignored `build/`.

- [ ] **Step 3: Run a non-mutating lint check**

Run: `npx eslint 'src/**/*.{js,ts}'`

Expected: exit 0. Do not use the repository's `npm run lint` script here
because it includes `--fix` and could silently rewrite files during verification.

- [ ] **Step 4: Run a manual smoke workflow using temporary repositories**

Create a temporary parent directory with two Git repositories and a temporary
home directory containing one DSS space:

```bash
DSS_SMOKE_ROOT="$(mktemp -d /tmp/dss-binding-smoke.XXXXXX)"
DSS_SMOKE_HOME="$DSS_SMOKE_ROOT/home"
DSS_SMOKE_PARENT="$DSS_SMOKE_ROOT/projects"
DSS_SMOKE_PRELOAD="$DSS_SMOKE_ROOT/mock-homedir.cjs"
DSS_CLI_PATH="$(pwd)/build/index.js"
mkdir -p "$DSS_SMOKE_HOME/.dss/spaces" "$DSS_SMOKE_PARENT/one" "$DSS_SMOKE_PARENT/two"
git -C "$DSS_SMOKE_PARENT/one" init
git -C "$DSS_SMOKE_PARENT/two" init
node -e 'const fs=require("fs"); const path=require("path"); const base=process.argv[1]; fs.writeFileSync(path.join(base,".dss/spaces/config.json"), JSON.stringify({spaces:[{name:"personal",email:"personal@example.com",userName:"Personal User",sshKeyPath:"/tmp/personal-key"}]}));' "$DSS_SMOKE_HOME"
node -e 'const fs=require("fs"); const target=process.argv[1]; const home=process.argv[2]; fs.writeFileSync(target, `const os=require("os"); os.homedir=()=>${JSON.stringify(home)};\n`);' "$DSS_SMOKE_PRELOAD" "$DSS_SMOKE_HOME"
node --require "$DSS_SMOKE_PRELOAD" "$DSS_CLI_PATH" bind personal --path "$DSS_SMOKE_PARENT/one"
node --require "$DSS_SMOKE_PRELOAD" "$DSS_CLI_PATH" status --path "$DSS_SMOKE_PARENT/one"
node --require "$DSS_SMOKE_PRELOAD" "$DSS_CLI_PATH" unbind --path "$DSS_SMOKE_PARENT/one"
cd "$DSS_SMOKE_PARENT"
node --require "$DSS_SMOKE_PRELOAD" "$DSS_CLI_PATH" bind personal -r --dry-run
```

Execute the final command with the temporary parent as the working directory.
Verify that bind changes only the first repository's effective identity,
status reports it, unbind restores the prior identity, and recursive dry-run
lists both repositories without changing either one.

- [ ] **Step 5: Verify repository state and scope**

Run: `git diff --check`

Expected: no output.

Run: `git status --short`

Expected: only intentional feature files are present before the final commit,
or no output when every task commit is complete.

Run: `git log --oneline upstream/main..HEAD`

Expected: the two design commits followed by focused implementation commits.

- [ ] **Step 6: Request code review and address findings**

Use `superpowers:requesting-code-review` with base `upstream/main` and the
current branch HEAD. Fix every Critical or Important finding through a new
failing regression test, rerun the focused test, and then rerun Steps 1-3.

- [ ] **Step 7: Use the branch-finishing workflow**

Invoke `superpowers:finishing-a-development-branch`, re-run the complete test
suite as required by that workflow, and present the integration options. For a
pull request, push `codex/repo-local-binding` to `origin` and target
`jalasem/dss:main` through the configured `upstream` remote.
