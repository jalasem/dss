import { execSync } from "child_process";
import { input, confirm, select } from "@inquirer/prompts";
import os from "os";
import fs from "fs-extra";
import path from "path";
import { generateSSHKey } from "./sshKeyGen";
import { copyToClipboard } from ".";
import { IConfig, ISpace } from "./types";

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
      await copyToClipboard(publicKey);

      console.log(
        "The public SSH key has been copied to your clipboard. Please add it to your GitHub account or wherever it's needed. \n"
      );
      console.log("Public SSH Key:\n" + publicKey);
      console.log(
        "GitHub SSH Key Addition URL: https://github.com/settings/keys\n"
      );
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

  const switchToNewSpace = await confirm({
    message: `Do you want to switch to the newly added space "${name}" now?`,
    default: true,
  });

  if (switchToNewSpace) {
    await switchSpace(name);
  } else {
    console.log(`Space "${name}" added successfully.`);
  }
}

export async function listSpaces() {
  await ensureConfigFileExists();

  const config: IConfig = await fs.readJson(configPath);

  if (config.spaces.length === 0) {
    console.log("⚠️ No spaces have been added yet.");
    return;
  }

  let maxWidthName = "Name".length;
  let maxWidthEmail = "Email".length;
  let maxWidthUserName = "User Name".length;
  config.spaces.forEach((space) => {
    const nameLength =
      space.name.length + (space.name === config.activeSpace ? 3 : 0);
    maxWidthName = Math.max(maxWidthName, nameLength);
    maxWidthEmail = Math.max(maxWidthEmail, space.email.length);
    maxWidthUserName = Math.max(maxWidthUserName, space.userName.length);
  });

  const header = `| ${"Name".padEnd(maxWidthName)} | ${"Email".padEnd(maxWidthEmail)} | ${"User Name".padEnd(maxWidthUserName)} |`;

  const topBottomBar = "+" + "-".repeat(header.length - 2) + "+\n";

  console.log("Your Spaces:");
  console.log(topBottomBar);
  console.log(header);
  console.log("-".repeat(header.length));

  config.spaces.forEach((space) => {
    const displayName = `${space.name === config.activeSpace ? "🔥" : ""}${space.name}`;
    const row = `| ${displayName.padEnd(maxWidthName)} | ${space.email.padEnd(maxWidthEmail)} | ${space.userName.padEnd(maxWidthUserName)} |`;
    console.log(row);
  });

  console.log(topBottomBar);
}

export async function switchSpace(
  spaceName?: string | { name: string }
): Promise<void> {
  const spaceNameProvided = spaceName
    ? typeof spaceName === "string"
      ? spaceName
      : spaceName.name
    : null;

  await ensureConfigFileExists();
  const config: IConfig = await fs.readJson(configPath);

  if (config.spaces.length === 0) {
    console.log("No spaces have been added yet.");
    return;
  }

  let selectedSpaceName =
    spaceNameProvided ||
    (await select({
      message: "Please choose a space to switch to: ",
      choices: config.spaces.map((space) => ({
        title: space.name,
        value: space.name,
      })),
    }));

  const space = config.spaces.find((s) => s.name === selectedSpaceName);
  if (!space || !space.sshKeyPath) {
    console.log(
      `Space "${selectedSpaceName}" not found or does not have an associated SSH key. \n`
    );
    return;
  }

  if (config.activeSpace === selectedSpaceName) {
    console.log(`Space "${selectedSpaceName}" is already active. \n`);
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
    console.log(`Switched to and activated space "${space.name}". \n`);

    listSpaces();
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
