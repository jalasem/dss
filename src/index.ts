#!/usr/bin/env node
import { program } from "commander";
import {
  addSpace,
  listSpaces,
  switchSpace,
  removeSpace,
  modifySpace,
  testSpace,
  inspectSpace,
  onboardUser,
} from "./utils/SpaceManager";
import { generateCompletionScript } from "./utils/completion";
import {
  batchSwitchSpaces,
  exportSpaceConfiguration,
  importSpaceConfiguration,
  bulkUpdateSpaces
} from "./utils/batchOperations";
import { UIHelper } from "./utils/ui";
import {
  bindSpaceToRepository,
  showRepositoryBindingStatus,
  unbindSpaceFromRepository
} from './utils/repoBindingCommands';

program
  .name("dss")
  .description(
    UIHelper.highlight("Dev Spaces Switcher (DSS)") + ": Manage your development spaces easily."
  )
  .version(require('../package.json').version, '-v, --version', 'output the current version');

program.command("add").description("Add a new space").action(addSpace);

program.command("list").description("List all spaces").action(listSpaces);

program
  .command("inspect [spaceName]")
  .description("Show detailed information about a space")
  .action(inspectSpace);

program
  .command("onboard")
  .description("Interactive onboarding for new users")
  .action(onboardUser);

program
  .command("completion [shell]")
  .description("Generate shell completion script (bash, zsh, fish)")
  .action(generateCompletionScript);

program
  .command("switch [spaceName]")
  .description("Switch to a specified space")
  .option('--dry-run', 'Preview changes without applying them')
  .action(switchSpace);

program
  .command("remove [spaceName]")
  .description("Remove a specified space")
  .option('--dry-run', 'Preview what would be removed without actually removing it')
  .action(removeSpace);

program
  .command("edit [spaceName]")
  .description("Modify an existing space")
  .action(modifySpace);

program
    .command("test")
    .description("Test the current space's access to GitHub")
    .action(testSpace)

// Batch operations
program
    .command("batch")
    .description("Batch operations for multiple spaces")
    .action(batchSwitchSpaces)

program
    .command("export")
    .description("Export space configuration")
    .action(exportSpaceConfiguration)

program
    .command("import")
    .description("Import space configuration")
    .action(importSpaceConfiguration)

program
    .command("bulk")
    .description("Bulk update operations for multiple spaces")
    .option('--dry-run', 'Preview changes without applying them')
    .action(bulkUpdateSpaces)

program
  .command('bind [spaceName]')
  .description('Bind a space to one or more Git repositories')
  .option('-p, --path <repositoryPath>', 'Bind an explicit Git repository')
  .option('-r, --recursive [parentPath]', 'Bind repositories beneath a parent directory')
  .option('--dry-run', 'Preview changes without applying them')
  .action(bindSpaceToRepository);

program
  .command('unbind')
  .description('Remove the DSS binding from a Git repository')
  .option('-p, --path <repositoryPath>', 'Select an explicit Git repository')
  .option('--dry-run', 'Preview changes without applying them')
  .action(unbindSpaceFromRepository);

program
  .command('status')
  .description('Show repository-local DSS binding status')
  .option('-p, --path <repositoryPath>', 'Select an explicit Git repository')
  .action(showRepositoryBindingStatus);

program.parse(process.argv);

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
  console.log(UIHelper.dim('\n💡 Getting Started:'));
  console.log(UIHelper.dim('  • ' + UIHelper.command('dss onboard') + ' - Interactive setup guide for new users'));
  console.log(UIHelper.dim('  • ' + UIHelper.command('dss add') + ' - Create your first development space'));
  console.log(UIHelper.dim('  • ' + UIHelper.command('dss list') + ' - View all your spaces'));
  console.log(UIHelper.dim('  • ' + UIHelper.command('dss switch') + ' - Switch between spaces'));
  console.log(UIHelper.dim('  • ' + UIHelper.command('dss test') + ' - Test GitHub access'));
  console.log(UIHelper.dim('\n📖 For detailed help: ' + UIHelper.command('dss <command> --help')));
}
