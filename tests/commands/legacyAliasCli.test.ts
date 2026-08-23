import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

// End-to-end coverage (Phase 3 · Task 2 review follow-up) proving, for the
// remaining legacy aliases that take a real identity/name and can be driven
// non-interactively, that invoking the OLD name both (a) prints the
// deprecation warning to stderr, and (b) actually delegates to — actually
// runs — the same handler as the new primary name, via a real observable
// side effect (not just a clean exit code).
//
// `bind`/`unbind` are covered the same way in tests/repoBindingCli.test.ts;
// `export`/`import` in tests/commands/configCli.test.ts; `list` is
// strengthened in tests/cli.test.ts. This file covers `switch`, `add`, and
// `remove` — the three that were previously untested as CLI invocations.

const CLI_PATH = path.join(__dirname, '../../build/index.js');

describe('legacy alias CLI commands (switch/add/remove) — warn + delegate', () => {
  const temporaryDirectories: string[] = [];
  let temporaryHome: string;

  async function createTemporaryDirectory(): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-legacy-alias-'));
    temporaryDirectories.push(directory);
    return fs.realpath(directory);
  }

  function cliEnvironment(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      HOME: temporaryHome,
      // `switch` re-applies global git config (writeActiveGitconfig +
      // ensureGlobalInclude) — sandbox git the same way
      // tests/repoBindingCli.test.ts does, so this never touches the real
      // machine's git config.
      GIT_CONFIG_GLOBAL: path.join(temporaryHome, 'empty-global.gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      XDG_CONFIG_HOME: path.join(temporaryHome, '.config')
    };
  }

  function runCli(args: string[], input = ''): { stdout: string; stderr: string; status: number | null } {
    const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
      cwd: temporaryHome,
      encoding: 'utf8',
      env: cliEnvironment(),
      input,
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
  });

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => fs.remove(directory)));
  });

  it('legacy "switch" delegates to switchSpace (persists the new active identity, prints its success output) and warns to point at "dss use"', async () => {
    await fs.outputJson(path.join(temporaryHome, '.dss', 'spaces', 'config.json'), {
      spaces: [
        { name: 'personal', email: 'p@x.com', userName: 'P', sshKeyPath: '' },
        { name: 'work', email: 'w@x.com', userName: 'W', sshKeyPath: '' }
      ]
    });

    // A named, keyless target needs no interactive prompts at all — real
    // end-to-end delegation proof without fighting piped-stdin fragility.
    const result = runCli(['switch', 'work']);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('"dss switch" is deprecated');
    expect(result.stderr).toContain('Use "dss use"');

    // Delegation proof #1: switchSpace's own success output.
    expect(result.stdout).toContain('Switched to: work');
    // Delegation proof #2: the real, persisted side effect only
    // switchSpace performs (updating the store's active identity).
    const config = await fs.readJson(path.join(temporaryHome, '.dss', 'spaces', 'config.json'));
    expect(config.active).toBe('work');
  });

  it('legacy "add" delegates to addSpace (its own header/prompt run for real) and warns to point at "dss new"', async () => {
    await fs.outputJson(path.join(temporaryHome, '.dss', 'spaces', 'config.json'), { spaces: [] });

    // addSpace's chained input()/select()/confirm() prompts can't be driven
    // reliably over a plain (non-TTY) piped stdin — @inquirer/prompts needs
    // real terminal raw-mode keypress semantics for a multi-prompt text
    // chain (verified directly: even a bare two-`input()`-prompt
    // @inquirer/prompts script exits non-zero with no output when fed a
    // piped `input` buffer of "line1\nline2\n" — this is a library/
    // environment limitation, not something under this codebase's control).
    // The interactive flow itself is already covered at the unit level in
    // tests/commands/spaces.test.ts (addSpace, with @inquirer/prompts
    // mocked).
    //
    // Closing stdin immediately instead is deterministic: the very first
    // prompt gets an immediate ExitPromptError, and addSpace's own
    // unconditional opening output — "Create New Development Space",
    // printed by UIHelper.printHeader as literally the first statement in
    // addSpace() — is real, content-specific proof the deprecatedAlias
    // wrapper actually delegated into addSpace rather than merely not
    // erroring.
    const result = runCli(['add'], '');

    expect(result.status).toBe(130); // isPromptExitError path in index.ts
    expect(result.stderr).toContain('"dss add" is deprecated');
    expect(result.stderr).toContain('Use "dss new"');
    expect(result.stdout).toContain('Create New Development Space');
  });

  it('legacy "remove" delegates to removeSpace (persists the removal, prints its success output) and warns to point at "dss rm"', async () => {
    await fs.outputJson(path.join(temporaryHome, '.dss', 'spaces', 'config.json'), {
      spaces: [{ name: 'personal', email: 'p@x.com', userName: 'P', sshKeyPath: '' }]
    });

    const result = runCli(['remove', 'personal'], 'y\n');

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('"dss remove" is deprecated');
    expect(result.stderr).toContain('Use "dss rm"');

    // Delegation proof #1: removeSpace's own success output.
    expect(result.stdout).toContain("has been removed successfully");
    // Delegation proof #2: the real, persisted side effect.
    const config = await fs.readJson(path.join(temporaryHome, '.dss', 'spaces', 'config.json'));
    expect(config.identities).toEqual([]);
  });
});
