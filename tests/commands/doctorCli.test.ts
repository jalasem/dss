import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

// End-to-end coverage (Phase 3 · Task 3) proving, for the `test`/`inspect`
// deprecation aliases wired onto `doctor` in src/index.ts, that invoking
// the OLD name both (a) prints the deprecation warning to stderr pointing
// at "dss doctor", and (b) actually delegates to — actually runs — the
// real doctor handler (not just a clean exit code), via doctor's own
// content-specific output.
//
// Uses a keyless identity throughout so the run is fully non-interactive
// and network-free (doctor skips the ssh-config/agent/host-auth checks
// entirely for a keyless identity) — deterministic without stubbing ssh.

const CLI_PATH = path.join(__dirname, '../../build/index.js');

describe('legacy "test"/"inspect" CLI commands — warn + delegate to doctor', () => {
  const temporaryDirectories: string[] = [];
  let temporaryHome: string;

  async function createTemporaryDirectory(): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-doctor-alias-'));
    temporaryDirectories.push(directory);
    return fs.realpath(directory);
  }

  function cliEnvironment(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      HOME: temporaryHome,
      GIT_CONFIG_GLOBAL: path.join(temporaryHome, 'empty-global.gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      XDG_CONFIG_HOME: path.join(temporaryHome, '.config')
    };
  }

  function runCli(args: string[]): { stdout: string; stderr: string; status: number | null } {
    const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
      cwd: temporaryHome,
      encoding: 'utf8',
      env: cliEnvironment(),
      timeout: 15000
    });
    return { stdout: result.stdout, stderr: result.stderr, status: result.status };
  }

  beforeAll(() => {
    // See tests/nonInteractiveCli.test.ts's beforeAll for why this is
    // skippable (review finding #5) — CI sets DSS_SKIP_TEST_BUILD=1 since
    // it already builds as its own step; local `npm test` still builds.
    if (process.env.DSS_SKIP_TEST_BUILD === '1') return;
    execFileSync('npm', ['run', 'build'], {
      cwd: path.join(__dirname, '../..'),
      stdio: 'inherit'
    });
  });

  beforeEach(async () => {
    temporaryHome = await createTemporaryDirectory();
    await fs.outputFile(path.join(temporaryHome, 'empty-global.gitconfig'), '');
    await fs.ensureDir(path.join(temporaryHome, '.config'));
    await fs.outputJson(path.join(temporaryHome, '.dss', 'spaces', 'config.json'), {
      spaces: [{ name: 'personal', email: 'p@x.com', userName: 'P', sshKeyPath: '' }]
    });
  });

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => fs.remove(directory)));
  });

  it('legacy "test <name>" warns to point at "dss doctor" and actually runs the doctor handler', () => {
    const result = runCli(['test', 'personal']);

    expect(result.stderr).toContain('"dss test" is deprecated');
    expect(result.stderr).toContain('Use "dss doctor".');

    // Delegation proof: doctor's own header + checklist output, not just a
    // clean exit — testSpace (the old handler) never printed "Doctor:".
    expect(result.stdout).toContain('Doctor: personal');
    expect(result.stdout).toContain('no SSH key configured');
  });

  it('legacy "inspect <name>" warns to point at "dss doctor" and actually runs the doctor handler', () => {
    const result = runCli(['inspect', 'personal']);

    expect(result.stderr).toContain('"dss inspect" is deprecated');
    expect(result.stderr).toContain('Use "dss doctor".');

    expect(result.stdout).toContain('Doctor: personal');
    expect(result.stdout).toContain('no SSH key configured');
  });

  it('a keyless identity is a hard failure: "test"/"inspect" (via doctor) both exit 1', () => {
    const result = runCli(['test', 'personal']);

    expect(result.status).toBe(1);
  });

  it('doctor itself (the new primary name) prints no deprecation warning', () => {
    const result = runCli(['doctor', 'personal']);

    expect(result.stderr).not.toContain('deprecated');
    expect(result.stdout).toContain('Doctor: personal');
  });

  it('advertises "doctor" in --help while "test"/"inspect" stay hidden (deprecated aliases)', () => {
    const result = runCli(['--help']);

    expect(result.stdout).toContain('doctor');
    expect(result.stdout).not.toMatch(/^\s+test\s/m);
    expect(result.stdout).not.toMatch(/^\s+inspect\s/m);
  });
});

// -----------------------------------------------------------------------
// KEYED identity, non-TTY, closed stdin — the actual hang regression this
// review round closes. `dss doctor` on a keyed identity used to call the
// interactive `testHostAccess`, which unconditionally awaits a "show the
// public key?" confirm() prompt reading process.stdin; run non-interactively
// (piped/closed stdin, as any script or CI invocation would), that await
// never resolves and the process hangs forever. doctor now calls the PURE
// `checkHostAccess` instead (no prompt at all), so this must complete
// promptly regardless of stdin. The real `ssh` binary is stubbed out via a
// fake executable prepended onto PATH so the outcome (auth success/failure)
// is deterministic and no real network call is made.
// -----------------------------------------------------------------------

describe('"dss doctor" on a KEYED identity — must not hang on stdin (no interactive prompt)', () => {
  const temporaryDirectories: string[] = [];
  let temporaryHome: string;
  let stubBinDirectory: string;
  let keyPath: string;

  async function createTemporaryDirectory(prefix: string): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return fs.realpath(directory);
  }

  /**
   * A fake `ssh` executable that never touches the network: exits with
   * $DSS_TEST_SSH_EXIT_CODE (default 0) after optionally writing
   * $DSS_TEST_SSH_STDERR to stderr, so a single stub script drives both
   * the auth-success and auth-failure cases via env vars. Placed on a
   * directory prepended to PATH — only `ssh` is shadowed; `ssh-keygen`/
   * `ssh-add` (used elsewhere by doctor's key/agent checks) still resolve
   * to the real binaries later in PATH.
   */
  async function installFakeSsh(): Promise<void> {
    const scriptPath = path.join(stubBinDirectory, 'ssh');
    await fs.outputFile(
      scriptPath,
      '#!/bin/sh\n' +
      'if [ -n "$DSS_TEST_SSH_STDERR" ]; then echo "$DSS_TEST_SSH_STDERR" 1>&2; fi\n' +
      'exit "${DSS_TEST_SSH_EXIT_CODE:-0}"\n'
    );
    await fs.chmod(scriptPath, 0o755);
  }

  function cliEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
      ...process.env,
      HOME: temporaryHome,
      GIT_CONFIG_GLOBAL: path.join(temporaryHome, 'empty-global.gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      XDG_CONFIG_HOME: path.join(temporaryHome, '.config'),
      PATH: `${stubBinDirectory}:${process.env.PATH}`,
      ...extra
    };
  }

  /** spawnSync with stdin explicitly closed (empty input) — the same
   * non-interactive shape a script/CI runner uses — and a hard timeout so
   * a regression fails fast instead of hanging the whole test suite. */
  function runDoctorNonInteractive(
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

  beforeAll(() => {
    // See tests/nonInteractiveCli.test.ts's beforeAll for why this is
    // skippable (review finding #5) — CI sets DSS_SKIP_TEST_BUILD=1 since
    // it already builds as its own step; local `npm test` still builds.
    if (process.env.DSS_SKIP_TEST_BUILD === '1') return;
    execFileSync('npm', ['run', 'build'], {
      cwd: path.join(__dirname, '../..'),
      stdio: 'inherit'
    });
  });

  beforeEach(async () => {
    temporaryHome = await createTemporaryDirectory('dss-doctor-keyed-');
    stubBinDirectory = await createTemporaryDirectory('dss-doctor-keyed-bin-');
    await installFakeSsh();
    await fs.outputFile(path.join(temporaryHome, 'empty-global.gitconfig'), '');
    await fs.ensureDir(path.join(temporaryHome, '.config'));

    keyPath = path.join(temporaryHome, '.dss', 'spaces', 'work', 'id_ed25519');
    await fs.ensureDir(path.dirname(keyPath));
    execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', keyPath, '-C', 'work@example.com']);

    await fs.outputJson(path.join(temporaryHome, '.dss', 'spaces', 'config.json'), {
      spaces: [{ name: 'work', email: 'work@example.com', userName: 'Work', sshKeyPath: keyPath }]
    });
  });

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => fs.remove(directory)));
  });

  it('completes promptly (does not hang) and renders "✓ Host auth" when the stubbed ssh call succeeds', () => {
    const result = runDoctorNonInteractive(['doctor', 'work'], { DSS_TEST_SSH_EXIT_CODE: '0' });

    // Not killed by the 10s timeout — the definitive non-hang proof.
    expect(result.signal).toBeNull();
    expect(result.elapsedMs).toBeLessThan(10000);
    expect(result.stdout).toContain('Doctor: work');
    expect(result.stdout).toContain('Host auth');
    expect(result.stdout.toLowerCase()).toContain('authenticated');
    // No interactive prompt was ever printed (that's testHostAccess-only).
    expect(result.stdout).not.toContain('Would you like to see the public SSH key?');
    expect(result.status).toBe(0);
  });

  it('completes promptly (does not hang) and renders "✗ Host auth" + exit 1 when the stubbed ssh call fails with no success marker', () => {
    const result = runDoctorNonInteractive(['doctor', 'work'], {
      DSS_TEST_SSH_EXIT_CODE: '255',
      DSS_TEST_SSH_STDERR: 'Permission denied (publickey).'
    });

    expect(result.signal).toBeNull();
    expect(result.elapsedMs).toBeLessThan(10000);
    expect(result.stdout).toContain('Doctor: work');
    expect(result.stdout).toContain('Host auth');
    expect(result.stdout).toContain('Permission denied');
    expect(result.stdout).not.toContain('Would you like to see the public SSH key?');
    // ✗-vs-! calibration preserved: a hard auth failure sets exit code 1.
    expect(result.status).toBe(1);
  });

  it('the deprecated "test <name>" alias on a keyed identity also completes promptly without hanging', () => {
    const result = runDoctorNonInteractive(['test', 'work'], { DSS_TEST_SSH_EXIT_CODE: '0' });

    expect(result.signal).toBeNull();
    expect(result.elapsedMs).toBeLessThan(10000);
    expect(result.stderr).toContain('"dss test" is deprecated');
    expect(result.stdout).toContain('Doctor: work');
  });
});

// -----------------------------------------------------------------------
// Review fix round (Important #1): getGitUser now passes `--includes` to
// `git config --global`, so the "Git identity drift" check must actually
// RESOLVE the effective identity through active.gitconfig's include chain
// in a real, unmocked, includeIf-first-configured sandbox — not report
// "unable to check", which is what it did before the fix (verified: this
// same setup, run against the pre-fix getGitUser, printed "unable to
// check" instead of a match/mismatch verdict).
// -----------------------------------------------------------------------

describe('"dss doctor" Git identity drift — resolves through the include chain (review fix: getGitUser --includes)', () => {
  const temporaryDirectories: string[] = [];
  let temporaryHome: string;

  async function createTemporaryDirectory(): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-doctor-drift-'));
    temporaryDirectories.push(directory);
    return fs.realpath(directory);
  }

  function cliEnvironment(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      HOME: temporaryHome,
      GIT_CONFIG_GLOBAL: path.join(temporaryHome, 'empty-global.gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      XDG_CONFIG_HOME: path.join(temporaryHome, '.config')
    };
  }

  function runCli(args: string[]): { stdout: string; stderr: string; status: number | null } {
    const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
      cwd: temporaryHome,
      encoding: 'utf8',
      env: cliEnvironment(),
      input: '',
      timeout: 10000
    });
    return { stdout: result.stdout, stderr: result.stderr, status: result.status };
  }

  beforeAll(() => {
    if (process.env.DSS_SKIP_TEST_BUILD === '1') return;
    execFileSync('npm', ['run', 'build'], {
      cwd: path.join(__dirname, '../..'),
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

  it('reports a MATCH (not "unable to check") once an identity is switched to via the includeIf-first active.gitconfig', () => {
    const created = runCli([
      'new', '--json', '-y',
      '--name', 'work', '--email', 'work@example.com', '--user', 'Work User',
      '--host', 'github.com', '--key', 'none'
    ]);
    expect(created.status).toBe(0);

    const result = runCli(['doctor', 'work']);

    // Exit 1 here comes from the unrelated "no SSH key configured" hard
    // failure (this identity was created with --key none) — not from the
    // drift check, which is exactly what this test is isolating.
    expect(result.stdout).toContain('Git identity drift');
    expect(result.stdout).not.toContain('unable to check');
    expect(result.stdout).toContain('Work User <work@example.com>');
    // PLAIN mode (non-TTY, this spawned process's default) renders a
    // SUCCESS status with no tag at all (UIHelper.printStatus's
    // plainTagByStatus.success === '') — a warning/error line always gets
    // an explicit "warn: "/"error: " prefix. A match is therefore the bare
    // "Git identity: ..." line, with neither prefix.
    const driftLine = result.stdout.split('\n').find(line => line.includes('Git identity: Work User'));
    expect(driftLine).toBeDefined();
    expect(driftLine).not.toMatch(/^(warn|error):/);
  });

  it('reports a real MISMATCH (not "unable to check") when checking a non-active identity', () => {
    const createActive = runCli([
      'new', '--json', '-y',
      '--name', 'work', '--email', 'work@example.com', '--user', 'Work User',
      '--host', 'github.com', '--key', 'none'
    ]);
    expect(createActive.status).toBe(0);
    // Created WITHOUT -y: stays inactive (global default remains "work").
    const createOther = runCli([
      'new', '--json',
      '--name', 'other', '--email', 'other@example.com', '--user', 'Other User',
      '--host', 'github.com', '--key', 'none'
    ]);
    expect(createOther.status).toBe(0);

    const result = runCli(['doctor', 'other']);

    expect(result.stdout).toContain('Git identity drift');
    expect(result.stdout).not.toContain('unable to check');
    // The effective (global) identity is still "work" — a genuine mismatch
    // against the "other" identity being checked, reported as a warning.
    expect(result.stdout).toContain('Work User <work@example.com>');
    const driftLine = result.stdout.split('\n').find(line => line.includes('Git identity: Work User'));
    expect(driftLine).toMatch(/^warn:/);
  });
});
