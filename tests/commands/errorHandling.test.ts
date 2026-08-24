import { CommanderError } from 'commander';
import { handleTopLevelError, mapCommanderExitCode } from '../../src/commands/errorHandling';
import { UsageError } from '../../src/commands/prompts';
import { UIHelper } from '../../src/commands/ui';
import { EXIT_CODES } from '../../src/core/exitCodes';
import { setJsonMode, captureCommanderOutput, _resetJsonStateForTests } from '../../src/commands/jsonOutput';
import { ConfigVersionError } from '../../src/infra/store';

// Phase 4 · Task 2 — unit-level coverage for the exit-code contract's 130
// (cancelled) row, which can't be forced at the CLI level: spawnSync's
// stdin is never a TTY, so isNonInteractive() always short-circuits before
// a real interactive prompt (and its ExitPromptError) could ever occur in
// a spawned test process. Exercises handleTopLevelError directly against a
// simulated ExitPromptError instead — see tests/exitCodes.test.ts for the
// CLI-level 0/1/2 matrix this complements.
//
// Also covers mapCommanderExitCode (the exitOverride mapping table) in
// isolation, since every code it maps is easy to construct directly here
// without spawning a process.

// Mirrors @inquirer/core exactly: the class does NOT override `name`, so
// isPromptExitError's detection can't rely on `error.name`.
class ExitPromptError extends Error {}

describe('handleTopLevelError', () => {
  let errorSpy: jest.SpyInstance;
  let infoSpy: jest.SpyInstance;
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    process.exitCode = undefined;
    errorSpy = jest.spyOn(UIHelper, 'error').mockImplementation(() => {});
    infoSpy = jest.spyOn(UIHelper, 'info').mockImplementation(() => {});
    // process.exit(130) would kill the Jest worker — stub it so the 130
    // path can be asserted without actually exiting.
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('130: an ExitPromptError (prompt cancelled) prints the friendly message and calls process.exit(130)', () => {
    handleTopLevelError(new ExitPromptError('User force closed the prompt with 0 null'));

    expect(infoSpy).toHaveBeenCalledWith('Prompt closed before an answer was given. No changes were made.');
    expect(exitSpy).toHaveBeenCalledWith(EXIT_CODES.CANCELLED);
    expect(exitSpy).toHaveBeenCalledWith(130);
  });

  it('2: a UsageError prints its message and sets process.exitCode to 2 without throwing', () => {
    handleTopLevelError(new UsageError('Missing required value: pass --name (non-interactive mode)'));

    expect(errorSpy).toHaveBeenCalledWith('Missing required value: pass --name (non-interactive mode)');
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('a CommanderError is mapped via mapCommanderExitCode and set as process.exitCode (Commander already printed its own message)', () => {
    const error = new CommanderError(1, 'commander.unknownCommand', "error: unknown command 'nope'");

    handleTopLevelError(error);

    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  // Task 5 fix round: an unhandled error used to reach this fallthrough
  // WITHOUT ever setting process.exitCode, which — combined with
  // flushJson() deriving `ok` from process.exitCode at flush time — made
  // --json mode report {ok:true} on a hard failure (see the JSON-mode
  // describe block below). Non-JSON mode still rethrows for a genuinely-
  // unexpected bug's stack trace, but the exit code is now set FIRST.
  it('anything else still rethrows, but now sets process.exitCode to 1 BEFORE rethrowing', () => {
    const boom = new Error('boom');
    expect(() => handleTopLevelError(boom)).toThrow(boom);
    expect(process.exitCode).toBe(EXIT_CODES.FAILURE);
  });

  // A ConfigVersionError (loadStore refusing an unrecognized/future config
  // version) is a distinct, EXPECTED failure — it gets the same clean
  // UIHelper.error()+exit-1 treatment as a UsageError, not a raw stack
  // trace, even though it isn't a UsageError itself.
  it('a ConfigVersionError prints its own message via UIHelper.error and sets process.exitCode to 1 without throwing', () => {
    const error = new ConfigVersionError('Unsupported config version 3 in /x/config.json — this build of DSS only understands up to version 2.');

    expect(() => handleTopLevelError(error)).not.toThrow();

    expect(errorSpy).toHaveBeenCalledWith(error.message);
    expect(process.exitCode).toBe(EXIT_CODES.FAILURE);
  });
});

// Phase 4 · Task 3 — handleTopLevelError's --json integration: every
// handled error path (cancelled/UsageError/CommanderError) must flush a
// single `{ok:false, command, error}` object to stdout in JSON mode.
describe('handleTopLevelError (JSON mode)', () => {
  let writeSpy: jest.SpyInstance;
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    process.exitCode = undefined;
    writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.exitCode = undefined;
    _resetJsonStateForTests();
  });

  it('130: an ExitPromptError flushes {ok:false, error:{message:"cancelled"}} before exiting', () => {
    setJsonMode('use');
    handleTopLevelError(new ExitPromptError('User force closed the prompt with 0 null'));

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(writeSpy.mock.calls[0][0] as string)).toEqual({
      ok: false,
      command: 'use',
      error: { message: 'cancelled' },
    });
    expect(exitSpy).toHaveBeenCalledWith(EXIT_CODES.CANCELLED);
  });

  it('2: a UsageError flushes {ok:false, error:{message: <the UsageError message>}}', () => {
    setJsonMode('new');
    handleTopLevelError(new UsageError('Missing required value: pass --name (non-interactive mode)'));

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(writeSpy.mock.calls[0][0] as string)).toEqual({
      ok: false,
      command: 'new',
      error: { message: 'Missing required value: pass --name (non-interactive mode)' },
    });
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
  });

  it('2: an unknown-command CommanderError flushes {ok:false, error:{message}}', () => {
    setJsonMode('dss');
    const error = new CommanderError(1, 'commander.unknownCommand', "error: unknown command 'nope'");

    handleTopLevelError(error);

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(writeSpy.mock.calls[0][0] as string)).toEqual({
      ok: false,
      command: 'dss',
      error: { message: "error: unknown command 'nope'" },
    });
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
  });

  // Review finding #2 — a --help CommanderError (exit 0) does NOT get an
  // error object, and Commander's own captured writeOut text (via
  // program.configureOutput() in index.ts, simulated here directly via
  // captureCommanderOutput) surfaces as `data.help`.
  it('a --help CommanderError (exit 0) surfaces the captured Commander output as data.help — ok:true, no error', () => {
    setJsonMode('dss');
    captureCommanderOutput('Usage: dss [options] [command]\n\nCommands:\n  ls ...\n');
    const error = new CommanderError(0, 'commander.helpDisplayed', '(display help)');

    handleTopLevelError(error);

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(writeSpy.mock.calls[0][0] as string)).toEqual({
      ok: true,
      command: 'dss',
      data: { help: 'Usage: dss [options] [command]\n\nCommands:\n  ls ...\n' },
    });
    expect(process.exitCode).toBe(EXIT_CODES.OK);
  });

  it('a --version CommanderError (exit 0) surfaces the captured Commander output as data.version (trimmed) — ok:true, no error', () => {
    setJsonMode('dss');
    captureCommanderOutput('1.2.3\n');
    const error = new CommanderError(0, 'commander.version', '1.2.3');

    handleTopLevelError(error);

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(writeSpy.mock.calls[0][0] as string)).toEqual({
      ok: true,
      command: 'dss',
      data: { version: '1.2.3' },
    });
    expect(process.exitCode).toBe(EXIT_CODES.OK);
  });

  // Review finding #1: the dual-purpose 'commander.help' case, mapped to
  // exit 2 by mapCommanderExitCode — its own error.message is just
  // Commander's internal placeholder ('(outputHelp)'), so a real message is
  // substituted instead of surfacing that placeholder (or an empty
  // data.help) as the JSON error.
  it('a wrong-invocation commander.help CommanderError (exit 2) flushes a real error message, not the "(outputHelp)" placeholder', () => {
    setJsonMode('dss');
    const error = new CommanderError(1, 'commander.help', '(outputHelp)');

    handleTopLevelError(error);

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(writeSpy.mock.calls[0][0] as string)).toEqual({
      ok: false,
      command: 'dss',
      error: { message: 'missing or unknown subcommand' },
    });
    expect(process.exitCode).toBe(EXIT_CODES.USAGE);
  });

  // Task 5 fix round regression coverage: this is the exact case the review
  // flagged — an unknown error (e.g. a ConfigVersionError propagating out of
  // loadStore) used to flush {ok:true, data:{}} while the process went on to
  // exit 1, because process.exitCode was never set before flushJson() ran.
  it('1: a ConfigVersionError flushes {ok:false, error:{message}} and does NOT rethrow in JSON mode', () => {
    setJsonMode('ls');
    const error = new ConfigVersionError('Unsupported config version 3 in /x/config.json — this build of DSS only understands up to version 2.');

    expect(() => handleTopLevelError(error)).not.toThrow();

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(writeSpy.mock.calls[0][0] as string)).toEqual({
      ok: false,
      command: 'ls',
      error: { message: error.message },
    });
    expect(process.exitCode).toBe(EXIT_CODES.FAILURE);
  });

  it('1: any other unknown error also flushes {ok:false, error:{message}} and does NOT rethrow in JSON mode (the JSON object is the output)', () => {
    setJsonMode('ls');
    const boom = new Error('boom: something unexpected broke');

    expect(() => handleTopLevelError(boom)).not.toThrow();

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(writeSpy.mock.calls[0][0] as string)).toEqual({
      ok: false,
      command: 'ls',
      error: { message: 'boom: something unexpected broke' },
    });
    expect(process.exitCode).toBe(EXIT_CODES.FAILURE);
  });

  it('not in JSON mode: flushJson() never writes (UIHelper.error is still called exactly as the non-JSON describe block above already proves)', () => {
    // UIHelper.error() itself still calls the real console.log -> a real
    // process.stdout.write (proven directly below) — mocked out here so
    // this test isolates flushJson()'s OWN write (which must be zero,
    // since isJsonMode() is false) from that unrelated decorative output.
    const errorSpy = jest.spyOn(UIHelper, 'error').mockImplementation(() => {});

    handleTopLevelError(new UsageError('missing --name'));

    expect(errorSpy).toHaveBeenCalledWith('missing --name');
    expect(writeSpy).not.toHaveBeenCalled();
  });
});

describe('mapCommanderExitCode', () => {
  it.each([
    'commander.unknownCommand',
    'commander.unknownOption',
    'commander.missingArgument',
    'commander.invalidArgument',
    'commander.missingMandatoryOptionValue',
    'commander.excessArguments',
    // P4-T2 review, Important #1 + Minor: both were missing from the
    // brief's original 6-code list — the controller ruled both are
    // usage-class, not a deliberate exclusion.
    'commander.optionMissingArgument',
    'commander.conflictingOption'
  ])('maps %s to exit 2 (usage)', (code) => {
    expect(mapCommanderExitCode(new CommanderError(1, code, 'message'))).toBe(EXIT_CODES.USAGE);
  });

  it.each([
    'commander.helpDisplayed',
    'commander.help',
    'commander.version'
  ])('maps %s to exit 0 (success) when error.exitCode is 0', (code) => {
    expect(mapCommanderExitCode(new CommanderError(0, code, 'message'))).toBe(EXIT_CODES.OK);
  });

  // Review finding #1: 'commander.help' is dual-purpose — Commander also
  // reuses it for help printed to stderr because the invocation was wrong
  // (`dss config` with no subcommand, `dss help badcmd`), which it signals
  // via error.exitCode: 1, not a different code. Trusting error.exitCode
  // (rather than blanket-mapping every SUCCESS_ERROR_CODES entry to OK) is
  // what keeps this at exit 2 instead of regressing to the pre-Phase-4
  // behavior's exit 1 turning into an erroneous exit 0.
  it('maps commander.help to exit 2 (usage) when error.exitCode is 1 (wrong invocation, not a real help request)', () => {
    expect(mapCommanderExitCode(new CommanderError(1, 'commander.help', '(outputHelp)'))).toBe(EXIT_CODES.USAGE);
  });

  it('keeps the exitCode of any other CommanderError as-is', () => {
    expect(mapCommanderExitCode(new CommanderError(1, 'commander.executeSubCommandAsync', 'message'))).toBe(1);
  });
});
