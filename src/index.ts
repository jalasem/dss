#!/usr/bin/env node
import { Command } from "commander";
import { buildProgram } from "./cli/program";
import { setAssumeYes } from './commands/prompts';
import { handleTopLevelError } from './commands/errorHandling';
import { dashboard } from './commands/dashboard';
import { setJsonMode, isJsonMode, flushJson } from './commands/jsonOutput';

// --json detection (review finding #2): pre-scan argv for `--json` BEFORE
// Commander does ANY parsing, rather than relying on Commander's own
// `option:json` event firing in argv order. Necessary because `-v`/
// `--version` (and `-h`/`--help`) THROW as soon as Commander encounters
// them mid-scan (exitOverride below makes that throw a CommanderError
// instead of calling process.exit directly) — parsing never reaches a
// LATER `--json` in the same argv (e.g. `dss -v --json`), so the
// event-based `option:json` handler would never fire in time. Scanning
// here first means JSON mode is already on by the time Commander touches
// ANY option, regardless of argv order.
const rawArgs = process.argv.slice(2);
if (rawArgs.includes('--json')) {
  setJsonMode('dss');
}

// Command construction itself (name/description/version, the two global
// options, exitOverride/configureOutput, the primary command surface, and
// the hidden deprecated aliases) lives in src/cli/program.ts — a
// side-effect-free builder that both this file and tests can call.
// exitOverride/configureOutput are set INSIDE buildProgram, before any
// subcommand is created there (Commander only copies them onto a
// subcommand at the moment it's created — see program.ts). Keeping
// construction out of this file is what lets src/commands/completion.ts
// derive its output against the LIVE `program` (passed into the
// `completion` command's action as a closure, inside buildProgram) without
// completion.ts ever importing this file back — see that module's
// describeProgram walker.
const { program, aliasPrimaryName } = buildProgram();

/**
 * The primary-command-name reported in `--json` mode's `{ok, command, ...}`
 * object: a deprecated alias (`dss list --json`) reports its PRIMARY name
 * ("ls"), and an ordinary (possibly nested, e.g. `config export`) command
 * reports its own full space-joined path.
 */
function primaryCommandName(actionCommand: Command): string {
  const aliasTarget = aliasPrimaryName.get(actionCommand);
  if (aliasTarget) return aliasTarget;

  const parts: string[] = [];
  for (let current: Command | null = actionCommand; current && current !== program; current = current.parent) {
    parts.unshift(current.name());
  }
  return parts.join(' ');
}

// Runs before every matched command's action — the earliest point at which
// Commander has resolved which command (including which alias) was actually
// invoked. A no-op unless `--json` was already turned on by the option:json
// handler above.
program.hook('preAction', (_program, actionCommand) => {
  if (isJsonMode()) setJsonMode(primaryCommandName(actionCommand));
});

// handleTopLevelError (the shared top-level error handler for both the
// bare-`dss` dashboard path and the normal Commander dispatch path below)
// lives in src/commands/errorHandling.ts, alongside the CommanderError exit
// code mapping it applies — see that module for the full contract; kept out
// of this file so it can be unit-tested without importing this file's own
// top-level parse/dispatch side effect.

// Bare `dss` (no args at all — or args that are ONLY the global -y/--yes/
// --json flags, which have no command of their own to attach to) runs the
// context dashboard instead of Commander's own dispatch — `dss --help`/
// `dss <command> --help` are untouched, since those still have an arg
// Commander needs to parse (a real command, or one of its own flags).
// Reuses `rawArgs` from the --json pre-scan at the top of this file.
const GLOBAL_ONLY_FLAGS = new Set(['-y', '--yes', '--json']);
const isBareDashboardInvocation = rawArgs.every(arg => GLOBAL_ONLY_FLAGS.has(arg));

// handleTopLevelError already flushes for every error shape it handles
// (see src/commands/errorHandling.ts) — the try/finally here is belt and
// braces so an error it doesn't handle (rethrown, propagating past this
// point as an unhandled rejection) still can't skip the flush.
function runAndFlush(run: () => Promise<unknown>): void {
  run()
    .then(() => flushJson())
    .catch(error => {
      try {
        handleTopLevelError(error);
      } finally {
        flushJson();
      }
    });
}

if (isBareDashboardInvocation) {
  if (rawArgs.includes('-y') || rawArgs.includes('--yes')) setAssumeYes(true);
  if (rawArgs.includes('--json')) setJsonMode('dashboard');
  runAndFlush(dashboard);
} else {
  runAndFlush(() => program.parseAsync(process.argv));
}
