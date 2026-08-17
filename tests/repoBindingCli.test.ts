import { execFileSync } from 'child_process';
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
    return directory;
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

  it('binds only the current repository when no repository option is supplied', () => {
    const sibling = path.join(temporaryHome, 'sibling');
    runGit(temporaryHome, ['init']);
    fs.ensureDirSync(sibling);
    runGit(sibling, ['init']);

    runCli(['bind', 'personal'], repository);

    expect(runGit(repository, ['config', 'dss.space'])).toBe('personal');
    expect(() => runGit(sibling, ['config', 'dss.space'])).toThrow();
  });

  it('recursively previews repositories from the current directory without binding them', async () => {
    const recursiveParent = path.join(temporaryHome, 'repositories');
    const alpha = await createRepository(recursiveParent, 'alpha');
    const beta = await createRepository(recursiveParent, 'beta');

    const output = runCli(['bind', 'personal', '-r', '--dry-run'], recursiveParent);

    expect(output).toContain(alpha);
    expect(output).toContain(beta);
    expect(() => runGit(alpha, ['config', 'dss.space'])).toThrow();
    expect(() => runGit(beta, ['config', 'dss.space'])).toThrow();
  });

  it('confirms recursive binding once before applying the sorted repositories', async () => {
    const recursiveParent = path.join(temporaryHome, 'repositories');
    const alpha = await createRepository(recursiveParent, 'alpha');
    const beta = await createRepository(recursiveParent, 'beta');

    const output = runCliWithInput(['bind', 'personal', '-r'], 'y\n', recursiveParent);

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

    const result = runCliFailure(['bind', 'personal', '-r'], recursiveParent, 'y\n');

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('1 succeeded, 1 failed');
    expect(result.output).toContain(unsafeRepository);
    expect(runGit(validRepository, ['config', 'dss.space'])).toBe('personal');
  });

  it('shows binding status for a bound repository', () => {
    runCli(['bind', 'personal', '--path', repository]);

    const output = runCli(['status', '--path', repository]);

    expect(output).toContain('personal@example.com');
    expect(output).toContain('personal');
  });

  it('treats an unbound repository as a successful status', () => {
    const output = runCli(['status', '--path', repository]);

    expect(output).toContain('Not bound');
  });

  it('unbinds only the repository DSS binding', () => {
    runCli(['bind', 'personal', '--path', repository]);

    runCli(['unbind', '--path', repository]);

    expect(() => runGit(repository, ['config', 'dss.space'])).toThrow();
  });

  it('previews unbinding without removing the DSS binding', () => {
    runCli(['bind', 'personal', '--path', repository]);

    const output = runCli(['unbind', '--path', repository, '--dry-run']);

    expect(output).toContain('Dry run');
    expect(runGit(repository, ['config', 'dss.space'])).toBe('personal');
  });

  it('rejects mutually exclusive repository selection options', () => {
    const result = runCliFailure(['bind', 'personal', '--path', repository, '-r']);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('mutually exclusive');
  });
});
