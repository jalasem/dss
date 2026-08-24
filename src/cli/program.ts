import { Command } from "commander";
import {
  addSpace,
  listSpaces,
  switchSpace,
  removeSpace,
  modifySpace,
} from "../commands/spaces";
import { generateCompletionScript } from "../commands/completion";
import { keyCommand } from "../commands/keys";
import {
  exportSpaceConfiguration,
  importSpaceConfiguration,
} from "../commands/batch";
import { UIHelper } from "../commands/ui";
import {
  bindSpaceToRepository,
  showRepositoryBindingStatus,
  unbindSpaceFromRepository
} from '../commands/binding';
import { setAssumeYes } from '../commands/prompts';
import { doctor } from '../commands/doctor';
import { addRule, listRules, rmRule } from '../commands/rule';
import { isJsonMode, captureCommanderOutput } from '../commands/jsonOutput';

export interface BuiltProgram {
  program: Command;
  // Maps each deprecated-alias Command object to the primary command name it
  // stands in for (e.g. the "list" alias command -> "ls") — see index.ts's
  // `primaryCommandName`, which uses this to report the PRIMARY name in the
  // `--json` mode `{ok, command, ...}` object for `dss list --json` etc.
  aliasPrimaryName: Map<Command, string>;
}

/**
 * Builds a fresh, fully-wired `dss` Command instance: name/description/
 * version, exitOverride/configureOutput, the two global options, the
 * primary command surface, and the hidden deprecated aliases.
 *
 * `-y`/`--yes`'s behavior (`setAssumeYes(true)`) is wired right here via
 * `.on('option:yes', ...)` below — Commander's own option-event mechanism
 * fires it in argv order, which is fine for a plain boolean flag. `--json`
 * is the one option whose behavior is NOT wired here: its detection is an
 * argv pre-scan in index.ts, run BEFORE Commander parses anything at all
 * (needed because `-v`/`-h` throw mid-parse — see index.ts's comment on
 * that pre-scan for why `option:json` firing in argv order isn't good
 * enough there). index.ts also owns the preAction hook that reports the
 * resolved command name once `--json` is on.
 *
 * Deliberately has NO side effects beyond constructing and returning the
 * Command tree — no argv parsing, no process.exit, nothing that reads
 * process.argv. That's what lets it be called more than once in the same
 * process (index.ts calls it exactly once for the real CLI; tests call it
 * to get an independent, throwaway Command instance to introspect via
 * `describeProgram` or feed to `generateCompletionScript`) without
 * import-cycle or duplicate-registration problems, and without needing to
 * import index.ts itself (completion.ts's own docs-drift/derived-completion
 * story depends on never importing index.ts back — see completion.ts).
 *
 * The `completion` command's action is wired here (not in index.ts) so it
 * can close over this exact `program` instance and generate completions
 * against the LIVE definition, per the Phase 4 · Task 4 brief.
 */
export function buildProgram(): BuiltProgram {
  const program = new Command();

  program
    .name("dss")
    .description(
      UIHelper.highlight("Dev Spaces Switcher (DSS)") + ": Manage your development identities easily."
    )
    .version(require('../../package.json').version, '-v, --version', 'output the current version')
    .option('-y, --yes', 'Assume "yes" for every confirmation prompt')
    .on('option:yes', () => setAssumeYes(true))
    .option('--json', 'Emit machine-readable JSON output (implies non-interactive mode)');

  // Makes Commander THROW a CommanderError instead of calling process.exit
  // itself for every one of its own errors (unknown command/option, missing
  // argument, --help, --version, ...) — required so those errors flow
  // through the same top-level catch chain as UsageError/ExitPromptError in
  // index.ts (handleTopLevelError maps the thrown CommanderError to this
  // CLI's exit-code contract). MUST run before any `program.command(...)`
  // call below: Commander copies the exit-override callback onto a
  // subcommand only at the moment that subcommand is created
  // (Command.prototype.copyInheritedSettings) — calling this any later
  // would leave every subcommand on Commander's default process.exit
  // behavior.
  program.exitOverride();

  // Routes Commander's own successful --help/--version text (writeOut)
  // through the JSON-mode guard: captured into the data payload (see
  // errorHandling.ts's CommanderError handling) instead of printed, in JSON
  // mode; printed exactly as before otherwise. Commander's own USAGE-error
  // text (unknown command/option, ...) goes through writeErr, untouched
  // here — that stays on stderr exactly as before. Same "before any
  // program.command(...) call" ordering requirement as exitOverride()
  // above — output configuration is inherited by subcommands at creation
  // time too.
  program.configureOutput({
    writeOut: (str) => {
      if (isJsonMode()) {
        captureCommanderOutput(str);
      } else {
        process.stdout.write(str);
      }
    }
  });

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

  const ruleCommand = program
    .command('rule')
    .description('Manage directory rules (compiled to native git includeIf)');

  ruleCommand
    .command('add <directory> <identityName>')
    .description('Add a directory rule: this identity applies automatically under <directory>')
    .action(addRule);

  ruleCommand
    .command('ls')
    .description('List directory rules')
    .action(listRules);

  ruleCommand
    .command('rm <directory>')
    .description('Remove a directory rule')
    .action(rmRule);

  program
    .command("completion [shell]")
    .description("Generate shell completion script (bash, zsh, fish)")
    .action((shell?: string) => generateCompletionScript(shell, program));

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

  return { program, aliasPrimaryName };
}
