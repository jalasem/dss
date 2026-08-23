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
import { isPromptExitError } from './commands/prompts';
import { dashboard } from './commands/dashboard';
import { doctor } from './commands/doctor';

program
  .name("dss")
  .description(
    UIHelper.highlight("Dev Spaces Switcher (DSS)") + ": Manage your development spaces easily."
  )
  .version(require('../package.json').version, '-v, --version', 'output the current version');

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
  cmd.action(async (...args: any[]) => {
    console.error(UIHelper.dim(
      `"dss ${oldName}" is deprecated and will be removed in v3. Use "dss ${newName}".`
    ));
    return handler(...args);
  });
}

// --- Primary command surface -------------------------------------------

program.command("ls").description("List all spaces").action(listSpaces);

program
  .command("use [spaceName]")
  .description("Switch to a specified space")
  .option('--dry-run', 'Preview changes without applying them')
  .action(switchSpace);

program.command("new").description("Add a new space").action(addSpace);

program
  .command("edit [spaceName]")
  .description("Modify an existing space")
  .action(modifySpace);

program
  .command("rm [spaceName]")
  .description("Remove a specified space")
  .option('--dry-run', 'Preview what would be removed without actually removing it')
  .action(removeSpace);

program
  .command('link [spaceName]')
  .description('Link a space to one or more Git repositories')
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
  .description('Export space configuration')
  .action(exportSpaceConfiguration);

configCommand
  .command('import [path]')
  .description('Import space configuration')
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

deprecatedAlias('switch [spaceName]', 'use', switchSpace, (cmd) => {
  cmd.option('--dry-run', 'Preview changes without applying them');
});

deprecatedAlias('add', 'new', addSpace);

deprecatedAlias('remove [spaceName]', 'rm', removeSpace, (cmd) => {
  cmd.option('--dry-run', 'Preview what would be removed without actually removing it');
});

deprecatedAlias('bind [spaceName]', 'link', bindSpaceToRepository, (cmd) => {
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

/**
 * Shared top-level error handler for both the bare-`dss` dashboard path and
 * the normal Commander dispatch path: a cancelled prompt exits quietly
 * (130) with a friendly message instead of an unhandled-rejection stack
 * trace; anything else rethrows.
 */
function handleTopLevelError(error: unknown): void {
  if (isPromptExitError(error)) {
    UIHelper.info('Prompt closed before an answer was given. No changes were made.');
    process.exit(130);
  }
  throw error;
}

// Bare `dss` (no args at all) runs the context dashboard instead of
// Commander's own dispatch — `dss --help`/`dss <command> --help` are
// untouched, since those still have an arg for Commander to parse.
if (!process.argv.slice(2).length) {
  dashboard().catch(handleTopLevelError);
} else {
  program.parseAsync(process.argv).catch(handleTopLevelError);
}
