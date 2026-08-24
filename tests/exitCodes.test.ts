import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

// Phase 4 · Task 2 — the exit-code contract's CLI-level test matrix: every
// row asserts the real spawned process's `.status` against one of the four
// codes DSS ever exits with (0/1/2/130). Reuses the sandbox pattern from
// tests/nonInteractiveCli.test.ts (temp HOME, DSS_NO_INPUT=1, closed
// stdin) so every non-interactive assertion here is reading the same
// guardedPrompt/UsageError machinery that test exercises directly — this
// file's job is just to prove the exit codes those paths (and Commander's
// own usage errors, new in this task) actually settle on.
//
// The 130 (cancelled) row is NOT here: forcing an actual interactive
// prompt inside a spawned, non-TTY test process isn't possible
// (isNonInteractive() checks stdin.isTTY, which spawnSync's pipes never
// satisfy) — that row is covered at the unit level instead, in
// tests/commands/errorHandling.test.ts, against a simulated
// ExitPromptError.

const CLI_PATH = path.join(__dirname, '../build/index.js');

describe('exit-code contract (CLI, spawned process)', () => {
  const temporaryDirectories: string[] = [];
  let temporaryHome: string;

  async function createTemporaryDirectory(): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-exitcodes-'));
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

  function runCli(
    args: string[],
    extraEnv: NodeJS.ProcessEnv = {}
  ): { stdout: string; stderr: string; status: number | null; signal: NodeJS.Signals | null } {
    const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
      cwd: temporaryHome,
      encoding: 'utf8',
      env: cliEnvironment(extraEnv),
      input: '',
      timeout: 10000
    });
    return { stdout: result.stdout, stderr: result.stderr, status: result.status, signal: result.signal };
  }

  async function writeConfig(spaces: Array<{ name: string; email: string; userName: string; sshKeyPath?: string }>): Promise<void> {
    await fs.outputJson(path.join(temporaryHome, '.dss', 'spaces', 'config.json'), { spaces });
  }

  beforeAll(() => {
    // See tests/nonInteractiveCli.test.ts's beforeAll for why this is
    // skippable (review finding #5) — CI sets DSS_SKIP_TEST_BUILD=1 since
    // it already builds as its own step; local `npm test` still builds.
    if (process.env.DSS_SKIP_TEST_BUILD === '1') return;
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

  describe('0 — success', () => {
    it('"dss ls" with identities present', async () => {
      await writeConfig([{ name: 'x', email: 'x@y.z', userName: 'X', sshKeyPath: '' }]);
      const result = runCli(['ls']);
      expect(result.status).toBe(0);
    });

    it('"dss --help"', () => {
      const result = runCli(['--help']);
      expect(result.status).toBe(0);
    });

    it('"dss --version"', () => {
      const result = runCli(['--version']);
      expect(result.status).toBe(0);
    });

    it('a successful "dss use <name>"', async () => {
      await writeConfig([{ name: 'x', email: 'x@y.z', userName: 'X', sshKeyPath: '' }]);
      const result = runCli(['use', 'x']);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Switched to: x');
    });
  });

  describe('1 — operational failure', () => {
    it('"dss use does-not-exist" (a valid command naming a nonexistent identity — operational, not usage)', async () => {
      await writeConfig([{ name: 'x', email: 'x@y.z', userName: 'X', sshKeyPath: '' }]);
      const result = runCli(['use', 'does-not-exist']);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('not found');
    });

    it('"dss rm does-not-exist -y" (non-interactive, -y supplied so it gets past the confirm guard to the not-found check)', async () => {
      await writeConfig([{ name: 'x', email: 'x@y.z', userName: 'X', sshKeyPath: '' }]);
      const result = runCli(['rm', 'does-not-exist', '-y']);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('not found');
    });

    it('"dss doctor <name>" hard-failure (a keyless identity — no SSH key configured is a hard failure, cheap/no network)', async () => {
      await writeConfig([{ name: 'personal', email: 'p@x.com', userName: 'P', sshKeyPath: '' }]);
      const result = runCli(['doctor', 'personal']);
      expect(result.status).toBe(1);
    });
  });

  describe('2 — usage error', () => {
    it('"dss nosuchcommand" (Commander unknownCommand)', () => {
      const result = runCli(['nosuchcommand']);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('unknown command');
    });

    it('"dss ls --nosuchflag" (Commander unknownOption)', () => {
      const result = runCli(['ls', '--nosuchflag']);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('unknown option');
    });

    it('"dss key" missing the required action argument (Commander missingArgument)', () => {
      const result = runCli(['key']);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('missing required argument');
    });

    it('"dss new" non-interactive with no flags (UsageError — missing --name)', async () => {
      await writeConfig([]);
      const result = runCli(['new']);
      expect(result.status).toBe(2);
      expect(result.stdout).toContain('Missing required value: pass --name (non-interactive mode)');
    });

    it('"dss use" non-interactive with no positional (UsageError — missing the identityName argument)', async () => {
      await writeConfig([{ name: 'x', email: 'x@y.z', userName: 'X', sshKeyPath: '' }]);
      const result = runCli(['use']);
      expect(result.status).toBe(2);
      expect(result.stdout).toContain('Missing required value: pass the identityName argument (non-interactive mode)');
    });

    // P4-T2 review, Important #1: --name given with no value is a Commander
    // 'commander.optionMissingArgument' error (distinct from --name being
    // omitted entirely, which is our own UsageError, tested above) — it was
    // missing from the exitOverride mapping table and fell through to
    // Commander's default exit 1, contradicting README.MD's own "missing
    // required argument -> exit 2".
    it('"dss new --name" with no value (Commander optionMissingArgument)', async () => {
      await writeConfig([]);
      const result = runCli(['new', '--name']);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('argument missing');
    });

    // Review finding #1: 'commander.help' is dual-purpose in Commander v12 —
    // `dss config` alone (a command with subcommands, none given) reuses the
    // same code as a real --help request, but signals it's actually a wrong
    // invocation via error.exitCode: 1. Base (pre-Phase-4) behavior exited 1
    // for this; the exit-code contract maps that to 2 (usage), not 0.
    it('"dss config" with no subcommand (commander.help, wrong-invocation case)', () => {
      const result = runCli(['config']);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('Usage: dss config');
    });

    // Review finding #3: a name-less "use" has nothing to prompt for and no
    // store to select from, on a completely fresh (empty) store — this must
    // NOT silently detour into firstRunFlow's optional (declines-silently)
    // confirm and exit 0; it's a missing positional in non-interactive mode,
    // same as the non-empty-store case above.
    it('"dss use" non-interactive on a FRESH (empty) store — no positional, no store to select from', async () => {
      await writeConfig([]);
      const result = runCli(['use']);
      expect(result.status).toBe(2);
      expect(result.stdout).toContain('Missing required value: pass the identityName argument (non-interactive mode)');
    });

    // Review finding #4: an unsupported shell value used to print an error
    // and exit 0 — it's a bad argument value (UsageError), same as any other
    // invalid flag/argument value in this CLI.
    it('"dss completion tcsh" (unsupported shell — bad argument value)', () => {
      const result = runCli(['completion', 'tcsh']);
      expect(result.status).toBe(2);
      expect(result.stdout).toContain('not supported');
    });
  });

  describe('deprecated alias spot-check', () => {
    it('"dss switch --nosuchflag" (deprecated alias for "use") exits 2, same as the primary command', () => {
      const result = runCli(['switch', '--nosuchflag']);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('unknown option');
    });
  });
});
