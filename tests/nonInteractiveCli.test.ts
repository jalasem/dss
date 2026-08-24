import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

// Phase 4 · Task 1 — CLI-level (real spawned process) coverage for the
// non-interactive foundation: every prompt has a flag, `--yes`/`-y` affirms
// confirms, and a non-TTY/closed stdin (or DSS_NO_INPUT=1) NEVER hangs —
// it either completes with zero prompts (given the right flags) or fails
// fast with a structured UsageError (exit 2) naming what's missing.
//
// Every invocation here closes stdin (`input: ''`) AND sets DSS_NO_INPUT=1
// — belt and braces, matching the brief's "spawnSync with stdin closed +
// DSS_NO_INPUT=1" — with a hard timeout so a regression (a guarded prompt
// wrapper that slipped through and still calls the real prompt) fails fast
// instead of hanging the whole suite.

const CLI_PATH = path.join(__dirname, '../build/index.js');

describe('non-interactive foundation (CLI, stdin closed + DSS_NO_INPUT=1)', () => {
  const temporaryDirectories: string[] = [];
  let temporaryHome: string;

  async function createTemporaryDirectory(): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-noninteractive-cli-'));
    temporaryDirectories.push(directory);
    return fs.realpath(directory);
  }

  function cliEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
      ...process.env,
      HOME: temporaryHome,
      GIT_CONFIG_GLOBAL: path.join(temporaryHome, 'empty-global.gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      XDG_CONFIG_HOME: path.join(temporaryHome, '.config'),
      DSS_NO_INPUT: '1',
      ...extra
    };
  }

  /** spawnSync with stdin explicitly closed (empty input), DSS_NO_INPUT=1,
   * and a hard timeout — a regression (a prompt call that slipped past a
   * guarded wrapper) fails fast instead of hanging the whole suite. */
  function runCli(
    args: string[],
    extraEnv: NodeJS.ProcessEnv = {}
  ): { stdout: string; stderr: string; status: number | null; signal: NodeJS.Signals | null; elapsedMs: number } {
    const startedAt = Date.now();
    const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
      cwd: temporaryHome,
      encoding: 'utf8',
      env: cliEnvironment(extraEnv),
      input: '',
      timeout: 10000
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      status: result.status,
      signal: result.signal,
      elapsedMs: Date.now() - startedAt
    };
  }

  function expectNoHang(result: { signal: NodeJS.Signals | null; elapsedMs: number }): void {
    expect(result.signal).toBeNull();
    expect(result.elapsedMs).toBeLessThan(10000);
  }

  async function writeConfig(spaces: Array<{ name: string; email: string; userName: string; sshKeyPath?: string }>): Promise<void> {
    await fs.outputJson(path.join(temporaryHome, '.dss', 'spaces', 'config.json'), { spaces });
  }

  beforeAll(() => {
    execFileSync('npm', ['run', 'build'], {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit'
    });
  });

  beforeEach(async () => {
    temporaryHome = await createTemporaryDirectory();
    await fs.outputFile(path.join(temporaryHome, 'empty-global.gitconfig'), '');
    await fs.ensureDir(path.join(temporaryHome, '.config'));
  });

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => fs.remove(directory)));
  });

  describe('dss new', () => {
    it('with every required flag (+ --key none) completes with ZERO prompts and exit 0', async () => {
      await writeConfig([]);

      const result = runCli([
        'new',
        '--name', 'wk',
        '--email', 'x@y.z',
        '--user', 'WK',
        '--host', 'github.com',
        '--key', 'none'
      ]);

      expectNoHang(result);
      expect(result.status).toBe(0);
      // No prompt text of any kind was ever printed.
      expect(result.stdout).not.toContain('Identity name:');
      expect(result.stdout).not.toContain('Email address:');
      expect(result.stdout).not.toContain('User name:');
      expect(result.stdout).not.toContain('Git host:');
      expect(result.stdout).not.toContain('Generate a new SSH key');

      const config = await fs.readJson(path.join(temporaryHome, '.dss', 'spaces', 'config.json'));
      const identity = config.identities.find((i: { name: string }) => i.name === 'wk');
      expect(identity).toBeDefined();
      expect(identity.email).toBe('x@y.z');
      expect(identity.userName).toBe('WK');
      expect(identity.host).toBe('github.com');
      // --key none: no SSH key generated.
      expect(identity.key).toBeUndefined();
    });

    it('with no flags at all exits 2, naming --name (the first missing required value)', async () => {
      await writeConfig([]);

      const result = runCli(['new']);

      expectNoHang(result);
      expect(result.status).toBe(2);
      expect(result.stdout).toContain('Missing required value: pass --name (non-interactive mode)');
      // Nothing was persisted.
      const config = await fs.readJson(path.join(temporaryHome, '.dss', 'spaces', 'config.json'));
      expect(config.identities ?? []).toHaveLength(0);
    });

    it('an invalid --key value exits 2 with a clear message, never touches stdin', async () => {
      await writeConfig([]);

      const result = runCli([
        'new',
        '--name', 'wk', '--email', 'x@y.z', '--user', 'WK', '--host', 'github.com',
        '--key', 'dsa'
      ]);

      expectNoHang(result);
      expect(result.status).toBe(2);
      expect(result.stdout).toContain('Invalid value for --key');
    });

    it('omitting --key (all other required flags given) defaults to generating an ed25519 key, matching the interactive default', async () => {
      await writeConfig([]);

      const result = runCli([
        'new',
        '--name', 'wk', '--email', 'x@y.z', '--user', 'WK', '--host', 'github.com',
        '--passphrase', ''
      ]);

      expectNoHang(result);
      expect(result.status).toBe(0);
      const config = await fs.readJson(path.join(temporaryHome, '.dss', 'spaces', 'config.json'));
      const identity = config.identities.find((i: { name: string }) => i.name === 'wk');
      expect(identity.key).toBeDefined();
      expect(identity.key.algorithm).toBe('ed25519');
    });
  });

  describe('dss rm', () => {
    beforeEach(async () => {
      await writeConfig([{ name: 'x', email: 'x@y.z', userName: 'X', sshKeyPath: '' }]);
    });

    it('without -y exits 2 (required-affirm confirm) and removes nothing', async () => {
      const result = runCli(['rm', 'x']);

      expectNoHang(result);
      expect(result.status).toBe(2);
      expect(result.stdout).toContain('Confirmation required: pass -y/--yes (non-interactive mode)');
      const config = await fs.readJson(path.join(temporaryHome, '.dss', 'spaces', 'config.json'));
      expect(config.identities).toHaveLength(1);
    });

    it('with -y proceeds: removes the identity and exits 0', async () => {
      const result = runCli(['rm', 'x', '-y']);

      expectNoHang(result);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('has been removed successfully');
      const config = await fs.readJson(path.join(temporaryHome, '.dss', 'spaces', 'config.json'));
      expect(config.identities).toHaveLength(0);
    });

    it('with no positional identity name exits 2 naming the identityName argument (a picker would otherwise open)', async () => {
      const result = runCli(['rm', '-y']);

      expectNoHang(result);
      expect(result.status).toBe(2);
      expect(result.stdout).toContain('Missing required value: pass the identityName argument (non-interactive mode)');
    });
  });

  describe('dss use', () => {
    it('a keyed identity switches successfully with NO hang — the optional post-switch "test access?" confirm resolves false silently', async () => {
      const keyPath = path.join(temporaryHome, '.dss', 'spaces', 'x', 'id_ed25519');
      await fs.ensureDir(path.dirname(keyPath));
      execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', keyPath, '-C', 'x@y.z']);
      await writeConfig([{ name: 'x', email: 'x@y.z', userName: 'X', sshKeyPath: keyPath }]);

      const result = runCli(['use', 'x']);

      expectNoHang(result);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Switched to: x');
      // The optional confirm never printed its question, and the SSH test
      // it would have triggered never ran.
      expect(result.stdout).not.toContain('Test SSH access');
      expect(result.stdout).not.toContain('Testing SSH Access');

      const config = await fs.readJson(path.join(temporaryHome, '.dss', 'spaces', 'config.json'));
      expect(config.active).toBe('x');
    });

    it('a keyless identity switches successfully with no hang (no confirm at all on this path)', async () => {
      await writeConfig([{ name: 'x', email: 'x@y.z', userName: 'X', sshKeyPath: '' }]);

      const result = runCli(['use', 'x']);

      expectNoHang(result);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Switched to: x');
    });

    it('with no positional identity name exits 2 naming the identityName argument', async () => {
      await writeConfig([{ name: 'x', email: 'x@y.z', userName: 'X', sshKeyPath: '' }]);

      const result = runCli(['use']);

      expectNoHang(result);
      expect(result.status).toBe(2);
      expect(result.stdout).toContain('Missing required value: pass the identityName argument (non-interactive mode)');
    });
  });

  describe('dss edit', () => {
    beforeEach(async () => {
      await writeConfig([{ name: 'x', email: 'old@y.z', userName: 'Old', sshKeyPath: '' }]);
    });

    it('with no flags at all keeps every current value (no error) — each field has a documented non-interactive default', async () => {
      const result = runCli(['edit', 'x']);

      expectNoHang(result);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('No changes were made');
      const config = await fs.readJson(path.join(temporaryHome, '.dss', 'spaces', 'config.json'));
      const identity = config.identities.find((i: { name: string }) => i.name === 'x');
      expect(identity.email).toBe('old@y.z');
      expect(identity.userName).toBe('Old');
    });

    it('with --email updates just that field, no prompts', async () => {
      const result = runCli(['edit', 'x', '--email', 'new@y.z']);

      expectNoHang(result);
      expect(result.status).toBe(0);
      const config = await fs.readJson(path.join(temporaryHome, '.dss', 'spaces', 'config.json'));
      const identity = config.identities.find((i: { name: string }) => i.name === 'x');
      expect(identity.email).toBe('new@y.z');
      expect(identity.userName).toBe('Old'); // unchanged, kept via non-interactive default
    });

    it('with no positional identity name exits 2 naming the identityName argument', async () => {
      const result = runCli(['edit']);

      expectNoHang(result);
      expect(result.status).toBe(2);
      expect(result.stdout).toContain('Missing required value: pass the identityName argument (non-interactive mode)');
    });
  });

  describe('dss link', () => {
    it('with no positional identity name exits 2 naming the identityName argument (a picker would otherwise open)', async () => {
      await writeConfig([{ name: 'x', email: 'x@y.z', userName: 'X', sshKeyPath: '/mock/key' }]);

      const result = runCli(['link']);

      expectNoHang(result);
      expect(result.status).toBe(2);
      expect(result.stdout).toContain('Missing required value: pass the identityName argument (non-interactive mode)');
    });
  });

  describe('dss completion', () => {
    it('with no shell argument exits 2 naming the shell argument', async () => {
      const result = runCli(['completion']);

      expectNoHang(result);
      expect(result.status).toBe(2);
      expect(result.stdout).toContain('Missing required value: pass the shell argument (non-interactive mode)');
    });

    it('with a shell argument completes with no hang; the "save to file?" confirm resolves false silently', async () => {
      const result = runCli(['completion', 'bash']);

      expectNoHang(result);
      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain('Would you like to save this script');
      const scriptPath = path.join(temporaryHome, 'dss-completion.bash');
      expect(await fs.pathExists(scriptPath)).toBe(false);
    });
  });

  describe('deprecated alias parity', () => {
    it('"remove x -y" (deprecated alias for "rm") behaves identically: removes and exits 0', async () => {
      await writeConfig([{ name: 'x', email: 'x@y.z', userName: 'X', sshKeyPath: '' }]);

      const result = runCli(['remove', 'x', '-y']);

      expectNoHang(result);
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('"dss remove" is deprecated');
      expect(result.stdout).toContain('has been removed successfully');
      const config = await fs.readJson(path.join(temporaryHome, '.dss', 'spaces', 'config.json'));
      expect(config.identities).toHaveLength(0);
    });
  });
});
