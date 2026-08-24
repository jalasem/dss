import { CommanderError } from 'commander';
import { handleTopLevelError, mapCommanderExitCode } from '../../src/commands/errorHandling';
import { UsageError } from '../../src/commands/prompts';
import { UIHelper } from '../../src/commands/ui';
import { EXIT_CODES } from '../../src/core/exitCodes';

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

  it('anything else rethrows unchanged', () => {
    const boom = new Error('boom');
    expect(() => handleTopLevelError(boom)).toThrow(boom);
    expect(process.exitCode).toBeUndefined();
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
  ])('maps %s to exit 0 (success)', (code) => {
    expect(mapCommanderExitCode(new CommanderError(0, code, 'message'))).toBe(EXIT_CODES.OK);
  });

  it('keeps the exitCode of any other CommanderError as-is', () => {
    expect(mapCommanderExitCode(new CommanderError(1, 'commander.executeSubCommandAsync', 'message'))).toBe(1);
  });
});
