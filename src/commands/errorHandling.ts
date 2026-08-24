import { CommanderError } from 'commander';
import { UIHelper } from './ui';
import { isPromptExitError, UsageError } from './prompts';
import { EXIT_CODES } from '../core/exitCodes';
import { isJsonMode, jsonData, jsonFail, flushJson, takeCommanderOutput } from './jsonOutput';
import { ConfigVersionError } from '../infra/store';

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
  if (SUCCESS_ERROR_CODES.has(error.code)) {
    // 'commander.help' is dual-purpose in Commander v12: help REQUESTED
    // (`--help`, `dss help ls`) exits 0, but Commander also reuses the same
    // code/handler for help printed to STDERR because the invocation itself
    // was wrong (`dss config` with no subcommand, `dss help badcmd`) — that
    // path sets error.exitCode to 1 (see Command.prototype.help in
    // commander's source). Trusting error.exitCode here (rather than
    // unconditionally returning OK for the whole SUCCESS_ERROR_CODES set)
    // is what keeps a wrong invocation at exit 2, matching base behavior
    // (both cases used to exit 1) instead of regressing to 0.
    return error.exitCode === 0 ? EXIT_CODES.OK : EXIT_CODES.USAGE;
  }
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
 * its own message, so it's just mapped to the right exit code; a
 * ConfigVersionError (loadStore refusing an unrecognized/future config
 * version — src/infra/store.ts) reports its own message and exits 1; any
 * other unknown error also exits 1, then in JSON mode returns quietly (the
 * flushed JSON object IS the output) or in non-JSON mode rethrows so a
 * genuinely-unexpected bug's stack trace stays visible.
 *
 * In JSON mode (--json), every handled case ALSO records the failure via
 * jsonFail (skipped for a CommanderError success code — --help/--version,
 * which instead surface Commander's captured output as `data.help`/
 * `data.version` — see takeCommanderOutput) and flushes the single JSON
 * object to stdout before returning/exiting — flushJson() is idempotent, so
 * index.ts's own end-of-chain flush (or a second call here) is always safe.
 *
 * IMPORTANT ordering: `process.exitCode` (or, for the cancelled path, the
 * code about to be passed to `process.exit()`) is assigned BEFORE
 * flushJson() runs in every branch below — flushJson() derives the JSON
 * object's `ok` field from `process.exitCode` at the moment it's called
 * (see jsonOutput.ts), so flushing before the exit code is set would
 * report `ok:true` even for a failure.
 *
 * TASK 5 FIX ROUND: the final fallthrough used to `throw error` without
 * EVER setting process.exitCode. flushJson() is called by index.ts's
 * runAndFlush in a `finally` AFTER that rethrow propagates back out — with
 * `ok` derived from `process.exitCode ?? 0`, a still-unset exit code at
 * flush time reported `{ok:true, data:{}}` on stdout even though the
 * process went on to exit 1 (Node's own unhandled-rejection default). A
 * script parsing --json output saw success on a hard failure — a genuine
 * violation of the "ok mirrors the exit code" contract. Every branch below,
 * including the final fallthrough, now sets process.exitCode BEFORE
 * returning/rethrowing.
 */
export function handleTopLevelError(error: unknown): void {
  if (isPromptExitError(error)) {
    // Set even though process.exit(EXIT_CODES.CANCELLED) below passes its
    // own code explicitly — flushJson() (called first) has no other way to
    // see the intended exit code.
    process.exitCode = EXIT_CODES.CANCELLED;
    if (isJsonMode()) {
      jsonFail('cancelled');
    } else {
      UIHelper.info('Prompt closed before an answer was given. No changes were made.');
    }
    flushJson();
    process.exit(EXIT_CODES.CANCELLED);
    // Unreachable in production (process.exit never returns) — the return
    // is here so a test that stubs process.exit (it must, to assert 130
    // without killing the test worker) doesn't fall through to the
    // CommanderError check and the final rethrow below.
    return;
  }
  if (error instanceof UsageError) {
    process.exitCode = EXIT_CODES.USAGE;
    if (isJsonMode()) {
      jsonFail(error.message);
    } else {
      UIHelper.error(error.message);
    }
    flushJson();
    return;
  }
  if (error instanceof CommanderError) {
    const exitCode = mapCommanderExitCode(error);
    process.exitCode = exitCode;
    if (isJsonMode()) {
      if (exitCode === EXIT_CODES.OK) {
        // --help/--version (review finding #2): Commander's own text was
        // captured instead of printed (program.configureOutput() in
        // index.ts, only active in JSON mode) — surface it as `data.help`/
        // `data.version` instead of silently emitting an empty `data: {}}`.
        const output = takeCommanderOutput();
        if (error.code === 'commander.version') {
          jsonData({ version: output.trim() });
        } else {
          jsonData({ help: output });
        }
      } else if (SUCCESS_ERROR_CODES.has(error.code)) {
        // The dual-purpose help-as-error case (review finding #1): Commander's
        // own `error.message` here is just its internal placeholder
        // ('(outputHelp)') and any captured writeOut text is the help dump
        // itself, not a real diagnostic — neither belongs in `error.message`,
        // so report a real message instead.
        jsonFail('missing or unknown subcommand');
      } else {
        jsonFail(error.message);
      }
    }
    flushJson();
    return;
  }
  if (error instanceof ConfigVersionError) {
    process.exitCode = EXIT_CODES.FAILURE;
    if (isJsonMode()) {
      jsonFail(error.message);
    } else {
      UIHelper.error(error.message);
    }
    flushJson();
    return;
  }
  // Any other unknown error (an infra failure not modeled by one of the
  // cases above) still owes the exit-code/--json contract: set exit 1
  // before doing anything else, so flushJson()'s `ok` (derived from
  // process.exitCode) comes out correctly regardless of what happens next.
  process.exitCode = EXIT_CODES.FAILURE;
  if (isJsonMode()) {
    jsonFail(error instanceof Error ? error.message : String(error));
    flushJson();
    return;
  }
  // Non-JSON mode: rethrow so a genuinely-unexpected bug's stack trace
  // stays visible for debugging — process.exitCode is already set above, so
  // index.ts's runAndFlush `finally { flushJson() }` (a no-op outside JSON
  // mode) and Node's own unhandled-rejection exit both agree with it.
  throw error;
}
