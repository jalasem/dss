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
