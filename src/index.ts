#!/usr/bin/env node
import { program } from "commander";
import {
  addSpace,
  listSpaces,
  switchSpace,
  removeSpace,
  modifySpace,
  testSpace,
} from "./utils/SpaceManager";
import {
  batchSwitchSpaces,
  exportSpaceConfiguration,
  importSpaceConfiguration,
  bulkUpdateSpaces
} from "./utils/batchOperations";
import { UIHelper } from "./utils/ui";

program
  .name("dss")
  .description(
    UIHelper.highlight("Dev Spaces Switcher (DSS)") + ": Manage your development spaces easily."
  )
  .version(require('../package.json').version);

program.command("add").description("Add a new space").action(addSpace);

program.command("list").description("List all spaces").action(listSpaces);

program
  .command("switch [spaceName]")
  .description("Switch to a specified space")
  .action(switchSpace);

program
  .command("remove [spaceName]")
  .description("Remove a specified space")
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
    .description("Bulk update operations")
    .action(bulkUpdateSpaces)

program.parse(process.argv);

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
  console.log(UIHelper.dim('\n💡 Start with: ' + UIHelper.command('dss add') + ' to create your first space'));
}
