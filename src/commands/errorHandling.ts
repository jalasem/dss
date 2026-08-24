import { CommanderError } from 'commander';
import { UIHelper } from './ui';
import { isPromptExitError, UsageError } from './prompts';
import { EXIT_CODES } from '../core/exitCodes';

// Commander's own usage-class errors (bad/missing invocation input) belong
// in the same exit-2 bucket as our own UsageError — everything else about
// them (message text, `program.error`'s stderr formatting) is untouched;
// only the exit code they carry is remapped.
const USAGE_ERROR_CODES = new Set([
  'commander.unknownCommand',
  'commander.unknownOption',
  'commander.missingArgument',
  'commander.invalidArgument',
  'commander.missingMandatoryOptionValue',
  'commander.excessArguments',
  // A flag given with no value (e.g. `dss new --name`) — same malformed-
  // invocation shape as the six above, just missing from the brief's
  // original list (P4-T2 review, Important #1).
  'commander.optionMissingArgument',
  // Not reachable today (no command uses Commander's own `.conflicts()` —
  // the one mutually-exclusive-option case, `link --path`/`--recursive`,
  // is enforced by hand via fail(), exit 1). Mapped preemptively so a
  // future `.conflicts()` usage doesn't silently regress to Commander's
  // default exit 1 (P4-T2 review, Minor).
  'commander.conflictingOption'
]);

// `--help` and `--version` are success paths, not errors, even though
// Commander's exitOverride() routes them through the same CommanderError
// throw as a real usage mistake.
const SUCCESS_ERROR_CODES = new Set([
  'commander.helpDisplayed',
  'commander.help',
  'commander.version'
]);

/**
 * Maps a CommanderError (thrown because `program.exitOverride()` is set —
 * see src/index.ts) to this CLI's exit-code contract. Any code not listed
 * above keeps whatever exitCode Commander already assigned it (Commander
 * defaults every error it doesn't special-case to 1).
 */
export function mapCommanderExitCode(error: CommanderError): number {
  if (SUCCESS_ERROR_CODES.has(error.code)) return EXIT_CODES.OK;
  if (USAGE_ERROR_CODES.has(error.code)) return EXIT_CODES.USAGE;
  return error.exitCode;
}

/**
 * Shared top-level error handler for both the bare-`dss` dashboard path and
 * the normal Commander dispatch path (see src/index.ts): a cancelled prompt
 * exits quietly (130) with a friendly message instead of an
 * unhandled-rejection stack trace; a UsageError from a guarded prompt
 * wrapper (src/commands/prompts.ts — a missing required flag/positional, or
 * a required confirm without -y in non-interactive mode) prints its message
 * and sets exit code 2; a CommanderError (Commander's own usage errors,
 * help, and version — see mapCommanderExitCode above) has already printed
 * its own message, so it's just mapped to the right exit code; anything
 * else rethrows.
 */
export function handleTopLevelError(error: unknown): void {
  if (isPromptExitError(error)) {
    UIHelper.info('Prompt closed before an answer was given. No changes were made.');
    process.exit(EXIT_CODES.CANCELLED);
    // Unreachable in production (process.exit never returns) — the return
    // is here so a test that stubs process.exit (it must, to assert 130
    // without killing the test worker) doesn't fall through to the
    // CommanderError check and the final rethrow below.
    return;
  }
  if (error instanceof UsageError) {
    UIHelper.error(error.message);
    process.exitCode = EXIT_CODES.USAGE;
    return;
  }
  if (error instanceof CommanderError) {
    process.exitCode = mapCommanderExitCode(error);
    return;
  }
  throw error;
}
