import { exec } from "child_process";
import { input, confirm, select } from "@inquirer/prompts";
import os from "os";
import fs from "fs-extra";
import path from "path";
import { generateSSHKey } from "./utils/sshKeyGen";
import { IConfig, ISpace } from "./types";
import { execSync } from "child_process";
import clipboard from "clipboardy";

const configPath = path.join(os.homedir(), ".dss", "spaces", "config.json");

async function ensureConfigFileExists() {
  await fs.ensureFile(configPath);
  const exists = await fs.readJson(configPath).catch(() => null);
  if (!exists) {
    await fs.writeJson(configPath, { spaces: [] });
  }
}

export async function addSpace() {
  await ensureConfigFileExists();

  const name = await input({
    message: "Space name: ",
    validate: (input) => !!input.trim() || "Space name is required!",
  });
  const email = await input({
    message: "Email: ",
    validate: (input) => !!input.trim() || "Email is required!",
  });
  const userName = await input({
    message: "User name: ",
    validate: (input) => !!input.trim() || "User name is required!",
  });
  const generateKey = await confirm({
    message: "Do you want to generate a new SSH key for this space?",
    default: true,
  });

  const config: IConfig = await fs.readJson(configPath);
  if (config.spaces.find((space) => space.name === name)) {
    console.log(`A space with the name "${name}" already exists.`);
    return;
  }

  let sshKeyPath = "";
  if (generateKey) {
    sshKeyPath = await generateSSHKey(name, email);
    const publicKeyPath = `${sshKeyPath}.pub`;

    try {
      const publicKey = await fs.readFile(publicKeyPath, "utf8");

      // Platform-specific command to copy the SSH public key to clipboard
      let copyCommand;
      switch (process.platform) {
        case "darwin":
          copyCommand = "pbcopy";
          break;
        case "win32":
          copyCommand = "clip";
          break;
        case "linux":
          copyCommand = "xclip -selection clipboard";
          break;
        default:
          throw new Error(
            `Platform ${process.platform} is not supported for clipboard operations.`
          );
      }

      exec(`echo "${publicKey}" | ${copyCommand}`, (error) => {
        if (error) {
          throw error;
        }
        console.log(
          "The public SSH key has been copied to your clipboard. Please add it to your GitHub account or wherever it's needed. \n"
        );
        console.log("Public SSH Key:\n" + publicKey, "\n");
        console.log(
          "GitHub SSH Key Addition URL: https://github.com/settings/keys"
        );
      });
    } catch (err) {
      console.error(
        "Failed to read the public SSH key or copy it to the clipboard.",
        (err as Error).message
      );
    }
  }

  const newSpace: ISpace = {
    name,
    email,
    userName,
    sshKeyPath,
  };

  config.spaces.push(newSpace);
  await fs.writeJson(configPath, config);
  console.log(`Space "${name}" added successfully.`);
}

export async function listSpaces() {
  await ensureConfigFileExists();

  const config: IConfig = await fs.readJson(configPath);

  if (config.spaces.length === 0) {
    console.log("⚠️ No spaces have been added yet.");
    return;
  }

  // Calculate column widths
  let maxWidthName = "Name".length;
  let maxWidthEmail = "Email".length;
  let maxWidthUserName = "User Name".length;
  config.spaces.forEach((space) => {
    maxWidthName = Math.max(maxWidthName, space.name.length);
    maxWidthEmail = Math.max(maxWidthEmail, space.email.length);
    maxWidthUserName = Math.max(maxWidthUserName, space.userName.length);
  });

  // Create a header
  const header = `| ${"Name".padEnd(maxWidthName)} | ${"Email".padEnd(maxWidthEmail)} | ${"User Name".padEnd(maxWidthUserName)} |`;

  // Create top and bottom bars
  const topBottomBar = "+" + "-".repeat(header.length - 2) + "+";

  console.log("Spaces:");
  console.log(topBottomBar); // Top bar
  console.log(header);
  console.log("-".repeat(header.length)); // Separator between header and rows

  // Display each space in tabular format
  config.spaces.forEach((space) => {
    const row = `| ${space.name.padEnd(maxWidthName)} | ${space.email.padEnd(maxWidthEmail)} | ${space.userName.padEnd(maxWidthUserName)} |`;
    console.log(row);
  });

  console.log(topBottomBar); // Bottom bar
}

export async function switchSpace(): Promise<void> {
  await ensureConfigFileExists();
  const config: IConfig = await fs.readJson(configPath);

  if (config.spaces.length === 0) {
    console.log("No spaces have been added yet.");
    return;
  }

  let selectedSpaceName = await select({
    message: "Please choose a space to switch to: ",
    choices: config.spaces.map((space) => ({
      title: space.name,
      value: space.name,
    })),
  });

  if (!selectedSpaceName) {
    selectedSpaceName = await select({
      message: "Please choose a space to switch to: ",
      choices: config.spaces.map((space) => ({
        title: space.name,
        value: space.name,
      })),
    });
  }

  const space = config.spaces.find((s) => s.name === selectedSpaceName);
  if (!space || !space.sshKeyPath) {
    console.log(
      `Space "${selectedSpaceName}" not found or does not have an associated SSH key.`
    );
    return;
  }

  try {
    // Set Git configuration
    execSync(`git config --global user.name "${space.userName}"`);
    execSync(`git config --global user.email "${space.email}"`);
    console.log(`Git user set to ${space.userName} <${space.email}>.`);

    // Add SSH key to the ssh-agent
    const addKeyCommand = `ssh-add ${space.sshKeyPath}`;
    console.log(`Adding SSH key from: ${space.sshKeyPath}`);
    execSync(addKeyCommand);
    console.log(`SSH key added to ssh-agent successfully.`);

    config.activeSpace = space.name;
    await fs.writeJson(configPath, config);
    console.log(`Switched to and activated space "${space.name}".`);
  } catch (error) {
    console.error(`Failed to switch to space "${selectedSpaceName}":`, error);
  }
}

export async function removeSpace() {
  await ensureConfigFileExists();
  const config: IConfig = await fs.readJson(configPath);

  if (config.spaces.length === 0) {
    console.log("⚠️ No spaces have been added yet.");
    return;
  }

  const spaceName = await select({
    message: "Select a space to remove:",
    choices: config.spaces.map((space) => ({
      title: space.name,
      value: space.name,
    })),
  });

  if (spaceName === config.activeSpace) {
    console.log(
      `Cannot remove the active space '${spaceName}'. Please switch to another space first.`
    );
    return;
  }

  const confirmRemoval = await confirm({
    message: `Are you sure you want to remove the space '${spaceName}'? This action cannot be undone.`,
    default: false,
  });

  if (!confirmRemoval) {
    console.log("Removal cancelled.");
    return;
  }

  // Proceed with removal
  config.spaces = config.spaces.filter((space) => space.name !== spaceName);
  await fs.writeJson(configPath, config);
  console.log(`Space '${spaceName}' has been removed.`);
}

export async function modifySpace() {
  await ensureConfigFileExists();
  const config: IConfig = await fs.readJson(configPath);

  if (config.spaces.length === 0) {
    console.log("⚠️ No spaces have been added yet.");
    return;
  }

  const selectedSpace = await select({
    message: "Which space would you like to modify?",
    choices: config.spaces.map((space) => ({
      name: space.name,
      value: space.name,
    })),
  });

  const space = config.spaces.find((space) => space.name === selectedSpace);
  if (!space) {
    console.log(`Space "${selectedSpace}" not found.`);
    return;
  }

  const spaceName = await input({
    message: `New name for "${space.name}" (leave blank to skip):`,
    default: space.name,
  });
  const email = await input({
    message: "New email (leave blank to skip):",
    default: space.email,
  });
  const userName = await input({
    message: "New user name (leave blank to skip):",
    default: space.userName,
  });

  let isUpdateMade = false;
  if (spaceName !== space.name) {
    if (config.spaces.some((s) => s.name === spaceName)) {
      console.log(`Another space with the name "${spaceName}" already exists.`);
      return;
    }
    space.name = spaceName;
    isUpdateMade = true;
  }
  if (email !== space.email) {
    space.email = email;
    isUpdateMade = true;
  }
  if (userName !== space.userName) {
    space.userName = userName;
    isUpdateMade = true;
  }

  await fs.writeJson(configPath, config);
  console.log(`Space "${selectedSpace}" updated.`);
}
