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
    // chain. The interactive flow itself is already covered at the unit
    // level in tests/commands/spaces.test.ts (addSpace, with
    // @inquirer/prompts mocked).
    //
    // Piped/closed stdin is non-interactive by definition (Phase 4 · Task
    // 1: isNonInteractive() = !stdin.isTTY) — addSpace's first guarded
    // prompt (--name) now fails FAST with a UsageError (exit 2) naming the
    // missing flag, never touching stdin at all, rather than the old
    // "read from stdin, get ExitPromptError, exit 130" path. addSpace's own
    // unconditional opening output — "Create New Identity", printed by
    // UIHelper.printHeader as literally the first statement in addSpace() —
    // is still real, content-specific proof the deprecatedAlias wrapper
    // actually delegated into addSpace rather than merely not erroring.
    const result = runCli(['add'], '');

    expect(result.status).toBe(2); // UsageError path in index.ts (Task 1)
    expect(result.stderr).toContain('"dss add" is deprecated');
    expect(result.stderr).toContain('Use "dss new"');
    expect(result.stdout).toContain('Create New Identity');
    // UIHelper.error (fail()'s underlying printer, and the UsageError path
    // in handleTopLevelError) writes to stdout, not stderr — matching every
    // other fail()-based error message in this codebase.
    expect(result.stdout).toContain('Missing required value: pass --name (non-interactive mode)');
  });

  it('legacy "remove" delegates to removeSpace (persists the removal, prints its success output) and warns to point at "dss rm", requiring -y non-interactively', async () => {
    await fs.outputJson(path.join(temporaryHome, '.dss', 'spaces', 'config.json'), {
      spaces: [{ name: 'personal', email: 'p@x.com', userName: 'P', sshKeyPath: '' }]
    });

    // Piped stdin ('y\n') is non-interactive by definition and is never
    // read for a required confirm any more — removeSpace's removal confirm
    // now needs the global -y/--yes flag instead (Phase 4 · Task 1).
    const result = runCli(['remove', 'personal', '-y']);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('"dss remove" is deprecated');
    expect(result.stderr).toContain('Use "dss rm"');

    // Delegation proof #1: removeSpace's own success output.
    expect(result.stdout).toContain("has been removed successfully");
    // Delegation proof #2: the real, persisted side effect.
    const config = await fs.readJson(path.join(temporaryHome, '.dss', 'spaces', 'config.json'));
    expect(config.identities).toEqual([]);
  });

  it('legacy "remove" without -y exits 2 (non-interactive) instead of hanging on the removal confirm', async () => {
    await fs.outputJson(path.join(temporaryHome, '.dss', 'spaces', 'config.json'), {
      spaces: [{ name: 'personal', email: 'p@x.com', userName: 'P', sshKeyPath: '' }]
    });

    const result = runCli(['remove', 'personal'], '');

    expect(result.status).toBe(2);
    expect(result.stdout).toContain('Confirmation required: pass -y/--yes (non-interactive mode)');
    const config = await fs.readJson(path.join(temporaryHome, '.dss', 'spaces', 'config.json'));
    expect(config.identities).toHaveLength(1); // untouched
  });
});
