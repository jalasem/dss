import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

const CLI_PATH = path.join(__dirname, '../build/index.js');

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

describe('repository binding CLI commands', () => {
  const temporaryDirectories: string[] = [];
  let temporaryHome: string;
  let homedirPreloadPath: string;
  let repository: string;

  async function createTemporaryDirectory(): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-binding-cli-'));
    temporaryDirectories.push(directory);
    return fs.realpath(directory);
  }

  function cliEnvironment(): NodeJS.ProcessEnv {
    const environment = { ...process.env };
    for (const variable of [
      'GIT_DIR',
      'GIT_WORK_TREE',
      'GIT_COMMON_DIR',
      'GIT_INDEX_FILE',
      'GIT_OBJECT_DIRECTORY',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES',
      'GIT_CEILING_DIRECTORIES',
      'GIT_PREFIX'
    ]) {
      delete environment[variable];
    }
    environment.GIT_CONFIG_GLOBAL = path.join(temporaryHome, 'empty-global.gitconfig');
    environment.GIT_CONFIG_NOSYSTEM = '1';
    environment.XDG_CONFIG_HOME = path.join(temporaryHome, '.config');
    return environment;
  }

  function runCli(args: string[], cwd: string = temporaryHome): string {
    return execFileSync(process.execPath, ['--require', homedirPreloadPath, CLI_PATH, ...args], {
      cwd,
      encoding: 'utf8',
      env: cliEnvironment()
    });
  }

  /** Like runCli, but returns stdout AND stderr separately (execFileSync
   * only surfaces stdout on success) — needed to assert on the deprecation
   * warning a legacy alias prints to stderr. */
  function runCliCapture(args: string[], cwd: string = temporaryHome): { stdout: string; stderr: string; status: number | null } {
    const result = spawnSync(process.execPath, ['--require', homedirPreloadPath, CLI_PATH, ...args], {
      cwd,
      encoding: 'utf8',
      env: cliEnvironment()
    });
    return { stdout: result.stdout, stderr: result.stderr, status: result.status };
  }

  function runCliWithInput(args: string[], input: string, cwd: string = temporaryHome): string {
    return execFileSync(process.execPath, ['--require', homedirPreloadPath, CLI_PATH, ...args], {
      cwd,
      encoding: 'utf8',
      env: cliEnvironment(),
      input
    });
  }

  function runCliFailure(
    args: string[],
    cwd: string = temporaryHome,
    input?: string
  ): { output: string; status: number | null } {
    try {
      if (input === undefined) {
        runCli(args, cwd);
      } else {
        runCliWithInput(args, input, cwd);
      }
    } catch (error) {
      const childProcessError = error as { stdout?: string; stderr?: string; status?: number };
      return {
        output: `${childProcessError.stdout || ''}${childProcessError.stderr || ''}`,
        status: childProcessError.status || null
      };
    }

    throw new Error('Expected the CLI command to fail.');
  }

  async function createRepository(parent: string, name: string): Promise<string> {
    const directory = path.join(parent, name);
    await fs.ensureDir(directory);
    runGit(directory, ['init']);
    return directory;
  }

  beforeAll(() => {
    execFileSync('npm', ['run', 'build'], {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit'
    });
  });

  beforeEach(async () => {
    temporaryHome = await createTemporaryDirectory();
    repository = path.join(temporaryHome, 'repository');
    homedirPreloadPath = path.join(temporaryHome, 'homedir-preload.cjs');

    await fs.outputJson(path.join(temporaryHome, '.dss', 'spaces', 'config.json'), {
      spaces: [{
        name: 'personal',
        email: 'personal@example.com',
        userName: 'Personal User',
        sshKeyPath: '/tmp/personal-key'
      }]
    });
    await fs.writeFile(
      homedirPreloadPath,
      `const os = require('os'); os.homedir = () => ${JSON.stringify(temporaryHome)};\n`
    );
    await fs.writeFile(path.join(temporaryHome, 'empty-global.gitconfig'), '');
    await fs.ensureDir(path.join(temporaryHome, '.config'));
    await fs.ensureDir(repository);
    runGit(repository, ['init']);
  });

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => fs.remove(directory)));
  });

  it('registers repository binding commands', () => {
    const output = runCli(['--help']);

    expect(output).toContain('link');
    expect(output).toContain('unlink');
    expect(output).toContain('status');
    // The legacy names are hidden from the top-level command listing.
    expect(output).not.toMatch(/^\s+bind\s/m);
    expect(output).not.toMatch(/^\s+unbind\s/m);
  });

  it('still binds via the legacy "bind" alias, printing a deprecation warning to stderr', () => {
    const result = runCliCapture(['bind', 'personal', '--path', repository]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('personal');
    expect(result.stderr).toContain('"dss bind" is deprecated');
    expect(result.stderr).toContain('Use "dss link"');
    expect(runGit(repository, ['config', 'dss.space'])).toBe('personal');
  });

  it('still unbinds via the legacy "unbind" alias, printing a deprecation warning to stderr', () => {
    runCli(['link', 'personal', '--path', repository]);

    const result = runCliCapture(['unbind', '--path', repository]);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('"dss unbind" is deprecated');
    expect(result.stderr).toContain('Use "dss unlink"');
    expect(() => runGit(repository, ['config', 'dss.space'])).toThrow();
  });

  it('binds an explicit repository path without changing the process working directory', () => {
    const output = runCli(['link', 'personal', '--path', repository]);

    expect(output).toContain('personal');
    expect(runGit(repository, ['config', 'user.email'])).toBe('personal@example.com');
    expect(runGit(repository, ['config', 'dss.space'])).toBe('personal');
  });

  it('records the binding in the store registry (config.json bindings) after a successful bind', async () => {
    runCli(['link', 'personal', '--path', repository]);

    const spacesConfigPath = path.join(temporaryHome, '.dss', 'spaces', 'config.json');
    const config = await fs.readJson(spacesConfigPath);
    const realRepository = await fs.realpath(repository);

    expect(config.version).toBe(2);
    expect(config.bindings).toEqual([{ path: realRepository, identity: 'personal' }]);
  });

  it('removes the binding from the store registry after a successful unbind', async () => {
    runCli(['link', 'personal', '--path', repository]);
    runCli(['unlink', '--path', repository]);

    const spacesConfigPath = path.join(temporaryHome, '.dss', 'spaces', 'config.json');
    const config = await fs.readJson(spacesConfigPath);

    expect(config.bindings).toEqual([]);
  });

  it('resolves a legacy raw-name space by its slug (dss link my-work)', async () => {
    // The v1 config below is migrated to v2 (silently, on first read), which
    // slugifies stored identity names — so the legacy "My Work" display name
    // becomes "my-work" in the persisted store from this point on.
    const spacesConfigPath = path.join(temporaryHome, '.dss', 'spaces', 'config.json');
    await fs.outputJson(spacesConfigPath, {
      spaces: [{
        name: 'My Work',
        email: 'work@example.com',
        userName: 'Work User',
        sshKeyPath: '/tmp/work-key'
      }]
    });

    const output = runCli(['link', 'my-work', '--path', repository]);

    expect(output).toContain('my-work');
    expect(runGit(repository, ['config', 'user.email'])).toBe('work@example.com');
    expect(runGit(repository, ['config', 'dss.space'])).toBe('my-work');
  });

  it('reports missing or malformed space configuration without a raw filesystem error', async () => {
    const spacesConfigPath = path.join(temporaryHome, '.dss', 'spaces', 'config.json');

    await fs.remove(spacesConfigPath);
    let result = runCliFailure(['link', '--path', repository]);
    expect(result.output).toContain('No spaces have been configured.');
    expect(result.output).not.toContain('ENOENT');

    await fs.outputJson(spacesConfigPath, { spaces: {} });
    result = runCliFailure(['link', '--path', repository]);
    expect(result.output).toContain('No spaces have been configured.');

    await fs.outputJson(spacesConfigPath, {
      spaces: [{ name: 'personal', email: 'personal@example.com', userName: 'Personal User' }]
    });
    result = runCliFailure(['link', 'personal', '--path', repository]);
    expect(result.output).toContain('does not have an SSH key.');
  });

  it('binds only the current repository when no repository option is supplied', () => {
    const sibling = path.join(temporaryHome, 'sibling');
    runGit(temporaryHome, ['init']);
    fs.ensureDirSync(sibling);
    runGit(sibling, ['init']);

    runCli(['link', 'personal'], repository);

    expect(runGit(repository, ['config', 'dss.space'])).toBe('personal');
    expect(() => runGit(sibling, ['config', 'dss.space'])).toThrow();
  });

  it('recursively previews repositories from the current directory without binding them', async () => {
    const recursiveParent = path.join(temporaryHome, 'repositories');
    const alpha = await createRepository(recursiveParent, 'alpha');
    const beta = await createRepository(recursiveParent, 'beta');

    const output = runCli(['link', 'personal', '-r', '--dry-run'], recursiveParent);

    expect(output).toContain(alpha);
    expect(output).toContain(beta);
    expect(() => runGit(alpha, ['config', 'dss.space'])).toThrow();
    expect(() => runGit(beta, ['config', 'dss.space'])).toThrow();
  });

  it('confirms recursive binding once before applying the sorted repositories', async () => {
    const recursiveParent = path.join(temporaryHome, 'repositories');
    const alpha = await createRepository(recursiveParent, 'alpha');
    const beta = await createRepository(recursiveParent, 'beta');

    const output = runCliWithInput(['link', 'personal', '-r'], 'y\n', recursiveParent);

    expect(output.indexOf(alpha)).toBeLessThan(output.indexOf(beta));
    expect(output).toContain('Bind 2 repositories to "personal"?');
    expect(runGit(alpha, ['config', 'dss.space'])).toBe('personal');
    expect(runGit(beta, ['config', 'dss.space'])).toBe('personal');
  });

  it('continues recursive binding after a repository fails and exits nonzero', async () => {
    const recursiveParent = path.join(temporaryHome, 'repositories');
    const unsafeRepository = await createRepository(recursiveParent, 'alpha-unsafe');
    const validRepository = await createRepository(recursiveParent, 'omega-valid');
    const externalDssDirectory = path.join(temporaryHome, 'external-dss');
    await fs.ensureDir(externalDssDirectory);
    await fs.symlink(externalDssDirectory, path.join(unsafeRepository, '.git', 'dss'));

    const result = runCliFailure(['link', 'personal', '-r'], recursiveParent, 'y\n');

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('1 succeeded, 1 failed');
    expect(result.output).toContain(unsafeRepository);
    expect(runGit(validRepository, ['config', 'dss.space'])).toBe('personal');
  });

  it('shows binding status for a bound repository', () => {
    runCli(['link', 'personal', '--path', repository]);

    const output = runCli(['status', '--path', repository]);

    expect(output).toContain('personal@example.com');
    expect(output).toContain('personal');
  });

  it('treats an unbound repository as a successful status', () => {
    const output = runCli(['status', '--path', repository]);

    expect(output).toContain('Not bound');
  });

  it('unbinds only the repository DSS binding', () => {
    runCli(['link', 'personal', '--path', repository]);

    runCli(['unlink', '--path', repository]);

    expect(() => runGit(repository, ['config', 'dss.space'])).toThrow();
  });

  it('previews unbinding without removing the DSS binding', () => {
    runCli(['link', 'personal', '--path', repository]);

    const output = runCli(['unlink', '--path', repository, '--dry-run']);

    expect(output).toContain('Dry run');
    expect(runGit(repository, ['config', 'dss.space'])).toBe('personal');
  });

  it('reports that there is nothing to remove for an unbound dry-run', () => {
    const output = runCli(['unlink', '--path', repository, '--dry-run']);

    expect(output).toContain('Dry run: there is no binding to remove.');
    expect(output).not.toContain('the existing binding would be removed');
  });

  it('rejects mutually exclusive repository selection options', () => {
    const result = runCliFailure(['link', 'personal', '--path', repository, '-r']);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('mutually exclusive');
  });
});
