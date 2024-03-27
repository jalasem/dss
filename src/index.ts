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

program
  .name("dss")
  .description(
    "Dev Spaces Switcher (DSS): Manage your development spaces easily."
  );

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

program.parse(process.argv);
