#!/usr/bin/env node
import { program, Command } from "commander";
import {
  addSpace,
  listSpaces,
  switchSpace,
  removeSpace,
  modifySpace,
} from "./commands/spaces";
import { generateCompletionScript } from "./commands/completion";
import { keyCommand } from "./commands/keys";
import {
  exportSpaceConfiguration,
  importSpaceConfiguration,
} from "./commands/batch";
import { UIHelper } from "./commands/ui";
import {
  bindSpaceToRepository,
  showRepositoryBindingStatus,
  unbindSpaceFromRepository
} from './commands/binding';
import { setAssumeYes } from './commands/prompts';
import { handleTopLevelError } from './commands/errorHandling';
import { dashboard } from './commands/dashboard';
import { doctor } from './commands/doctor';
import { setJsonMode, isJsonMode, flushJson } from './commands/jsonOutput';

program
  .name("dss")
  .description(
    UIHelper.highlight("Dev Spaces Switcher (DSS)") + ": Manage your development identities easily."
  )
  .version(require('../package.json').version, '-v, --version', 'output the current version')
  // Global (inherited by every subcommand): affirms every confirm prompt —
  // interactive or not — so scripts/CI can skip them outright, and is the
  // one thing that lets a REQUIRED confirm (rm, key rotate, recursive
  // link, config import) proceed without a TTY. Registered as an option
  // hook rather than read per-command so it's live before any command's
  // action runs, including the bare-`dss` dashboard path.
  .option('-y, --yes', 'Assume "yes" for every confirmation prompt')
  .on('option:yes', () => setAssumeYes(true))
  // Global machine-readable output (Phase 4 · Task 3): emits exactly ONE
  // JSON object to stdout and nothing else — see src/commands/jsonOutput.ts
  // for the full contract. Implies non-interactive mode (isNonInteractive()
  // in src/commands/prompts.ts checks isJsonMode() too). `'dss'` here is
  // only a placeholder command name for errors thrown before any command
  // resolves (e.g. an unknown command) — the preAction hook below overwrites
  // it with the actually-resolved primary command name once Commander
  // matches one.
  .option('--json', 'Emit machine-readable JSON output (implies non-interactive mode)')
  .on('option:json', () => setJsonMode('dss'));

// Makes Commander THROW a CommanderError instead of calling process.exit
// itself for every one of its own errors (unknown command/option, missing
// argument, --help, --version, ...) — required so those errors flow
// through the same top-level catch chain as UsageError/ExitPromptError
// below (handleTopLevelError maps the thrown CommanderError to this CLI's
// exit-code contract). Must run before any `program.command(...)` call:
// Commander copies the exit-override callback onto a subcommand only at
// the moment that subcommand is created.
program.exitOverride();

// Maps each deprecated-alias Command object to the primary command name it
// stands in for (e.g. the "list" alias command -> "ls"), so the --json
// preAction hook below can report the PRIMARY name for `dss list --json`
// instead of "list" — see primaryCommandName.
const aliasPrimaryName = new Map<Command, string>();

/**
 * Registers `oldNameAndArgs` as a legacy alias for `newName`: a hidden
 * Commander command (same args/options as the primary, via `configure`)
 * whose action FIRST prints a dim deprecation line to STDERR, then calls
 * the exact same handler used by the primary command — same behavior,
 * just reached under the old name a little longer. Hidden from the
 * top-level `--help` command listing (Commander v12 supports this via
 * `{ hidden: true }`) but still fully functional; removal is planned for
 * v3.
 */
function deprecatedAlias(
  oldNameAndArgs: string,
  newName: string,
  handler: (...args: any[]) => any,
  configure?: (cmd: Command) => void
): void {
  const oldName = oldNameAndArgs.split(' ')[0];
  const cmd = program.command(oldNameAndArgs, { hidden: true });
  cmd.description(`Deprecated: alias for "dss ${newName}" (removed in v3)`);
  if (configure) configure(cmd);
  aliasPrimaryName.set(cmd, newName);
  cmd.action(async (...args: any[]) => {
    console.error(UIHelper.dim(
      `"dss ${oldName}" is deprecated and will be removed in v3. Use "dss ${newName}".`
    ));
    return handler(...args);
  });
}

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

// --- Primary command surface -------------------------------------------

program.command("ls").description("List all identities").action(listSpaces);

program
  .command("use [identityName]")
  .description("Switch to a specified identity")
  .option('--dry-run', 'Preview changes without applying them')
  .action(switchSpace);

program
  .command("new")
  .description("Add a new identity")
  .option('--name <name>', 'Identity name (skips the name prompt)')
  .option('--email <email>', 'Email address (skips the email prompt)')
  .option('--user <userName>', 'Git user name (skips the user-name prompt)')
  .option('--host <host>', 'Git host (skips the host prompt)')
  .option('--key <type>', 'SSH key to generate: ed25519, rsa, or none (skips the key-generation confirm)')
  .option('--passphrase <passphrase>', 'Passphrase for the generated SSH key (default: empty)')
  .action(addSpace);

program
  .command("edit [identityName]")
  .description("Modify an existing identity")
  .option('--name <name>', 'New identity name (skips the name prompt)')
  .option('--email <email>', 'New email address (skips the email prompt)')
  .option('--user <userName>', 'New git user name (skips the user-name prompt)')
  .option('--host <host>', 'New git host (skips the host prompt)')
  .action(modifySpace);

program
  .command("rm [identityName]")
  .description("Remove a specified identity")
  .option('--dry-run', 'Preview what would be removed without actually removing it')
  .action(removeSpace);

program
  .command('link [identityName]')
  .description('Link an identity to one or more Git repositories')
  .option('-p, --path <repositoryPath>', 'Link an explicit Git repository')
  .option('-r, --recursive [parentPath]', 'Link repositories beneath a parent directory')
  .option('--dry-run', 'Preview changes without applying them')
  .action(bindSpaceToRepository);

program
  .command('unlink')
  .description('Remove the DSS link from a Git repository')
  .option('-p, --path <repositoryPath>', 'Select an explicit Git repository')
  .option('--dry-run', 'Preview changes without applying them')
  .action(unbindSpaceFromRepository);

program
  .command('key <action> [identityName]')
  .description('Manage SSH keys for an identity: show, copy, or rotate')
  .action(keyCommand);

const configCommand = program
  .command('config')
  .description('Manage DSS configuration (export/import)');

configCommand
  .command('export [path]')
  .description('Export identity configuration')
  .action(exportSpaceConfiguration);

configCommand
  .command('import [path]')
  .description('Import identity configuration')
  .action(importSpaceConfiguration);

program
  .command("completion [shell]")
  .description("Generate shell completion script (bash, zsh, fish)")
  .action(generateCompletionScript);

program
  .command('doctor [identityName]')
  .description('Run the full health check for an identity (key, ssh-config, host auth, git drift, binding)')
  .action(doctor);

program
  .command('status')
  .description('Show repository-local DSS binding status')
  .option('-p, --path <repositoryPath>', 'Select an explicit Git repository')
  .action(showRepositoryBindingStatus);

// --- Legacy aliases (deprecated, removed in v3) -------------------------
// Hidden from `--help`; still fully functional. Each prints a deprecation
// warning to stderr before delegating to the same handler as its new
// primary command above.

deprecatedAlias('list', 'ls', listSpaces);

deprecatedAlias('switch [identityName]', 'use', switchSpace, (cmd) => {
  cmd.option('--dry-run', 'Preview changes without applying them');
});

deprecatedAlias('add', 'new', addSpace, (cmd) => {
  cmd.option('--name <name>', 'Identity name (skips the name prompt)');
  cmd.option('--email <email>', 'Email address (skips the email prompt)');
  cmd.option('--user <userName>', 'Git user name (skips the user-name prompt)');
  cmd.option('--host <host>', 'Git host (skips the host prompt)');
  cmd.option('--key <type>', 'SSH key to generate: ed25519, rsa, or none (skips the key-generation confirm)');
  cmd.option('--passphrase <passphrase>', 'Passphrase for the generated SSH key (default: empty)');
});

deprecatedAlias('remove [identityName]', 'rm', removeSpace, (cmd) => {
  cmd.option('--dry-run', 'Preview what would be removed without actually removing it');
});

deprecatedAlias('bind [identityName]', 'link', bindSpaceToRepository, (cmd) => {
  cmd.option('-p, --path <repositoryPath>', 'Bind an explicit Git repository');
  cmd.option('-r, --recursive [parentPath]', 'Bind repositories beneath a parent directory');
  cmd.option('--dry-run', 'Preview changes without applying them');
});

deprecatedAlias('unbind', 'unlink', unbindSpaceFromRepository, (cmd) => {
  cmd.option('-p, --path <repositoryPath>', 'Select an explicit Git repository');
  cmd.option('--dry-run', 'Preview changes without applying them');
});

deprecatedAlias('export [path]', 'config export', exportSpaceConfiguration);
deprecatedAlias('import [path]', 'config import', importSpaceConfiguration);

// `test` and `inspect` are both absorbed by `doctor` (Phase 3 · Task 3):
// `test` (host auth) and `inspect` (detailed identity/key/config report)
// are now sections of doctor's single combined health check.
deprecatedAlias('test [identityName]', 'doctor', doctor);
deprecatedAlias('inspect [identityName]', 'doctor', doctor);

// `batch`, `bulk`, and `onboard` are gone (cut, no alias): batch/bulk had
// no comparable single-identity replacement worth keeping (per-identity
// `dss key rotate` replaces the SSH-key-regeneration case of `bulk`), and
// `onboard`'s tutorial is replaced by the automatic first-run flow that
// `dss ls` / `dss use` trigger when no identities exist yet.

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
const rawArgs = process.argv.slice(2);
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
