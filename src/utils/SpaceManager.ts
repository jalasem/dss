import { execSync } from "child_process";
import { input, confirm, select } from "@inquirer/prompts";
import os from "os";
import fs from "fs-extra";
import path from "path";
import { generateSSHKey } from "./sshKeyGen";
import { copyToClipboard, removeSSHKeyFromAgent, setGitHubSSHKey, testGithubAccess } from ".";
import { IConfig, ISpace, SpaceNameArg } from "./types";
import { UIHelper } from "./ui";
import { FuzzySpaceSearch, AutocompleteHelper } from "./fuzzySearch";

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

  UIHelper.printHeader("Create New Development Space");
  UIHelper.info("Please provide the following information:");
  
  const name = await input({
    message: "Space name:",
    validate: (input) => {
      if (!input.trim()) return "Space name is required!";
      if (input.length < 2) return "Space name must be at least 2 characters long";
      if (!/^[a-zA-Z0-9\s\-_]+$/.test(input)) return "Space name can only contain letters, numbers, spaces, hyphens, and underscores";
      return true;
    },
  });
  
  const email = (
    await input({
      message: "Email address:",
      validate: (input) => {
        if (!input.trim()) return "Email is required!";
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(input)) return "Please enter a valid email address";
        return true;
      },
    })
  )?.trim();
  
  const userName = await input({
    message: "User name:",
    validate: (input) => {
      if (!input.trim()) return "User name is required!";
      if (input.length < 2) return "User name must be at least 2 characters long";
      return true;
    },
  });
  
  const generateKey = await confirm({
    message: "Generate a new SSH key for this space?",
    default: true,
  });

  const config: IConfig = await fs.readJson(configPath);
  const slugifiedSpaceName = name.toLowerCase().replace(/\s/g, "-");

  if (config.spaces.find((space) => space.name === slugifiedSpaceName)) {
    UIHelper.error(`A space with the name "${name}" already exists.`);
    UIHelper.info("Please choose a different name or use " + UIHelper.command("dss edit") + " to modify the existing space.");
    return;
  }

  let sshKeyPath = "";
  if (generateKey) {
    UIHelper.printProgress("Generating SSH key");
    sshKeyPath = await generateSSHKey(slugifiedSpaceName, email);
    UIHelper.clearProgress();
    
    const publicKeyPath = `${sshKeyPath}.pub`;

    try {
      const publicKey = await fs.readFile(publicKeyPath, "utf8");
      await copyToClipboard(publicKey);

      UIHelper.success("SSH key generated successfully!");
      UIHelper.printSuccessBox("SSH Key Ready", [
        "✓ Public key copied to clipboard",
        "✓ Add it to your GitHub account",
        "",
        "GitHub SSH Keys: https://github.com/settings/keys"
      ]);
      
      console.log(UIHelper.dim("\nPublic SSH Key:"));
      console.log(UIHelper.highlight(publicKey));
    } catch (err) {
      UIHelper.error(
        "Failed to read the public SSH key or copy it to the clipboard: " +
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
    UIHelper.info("Switching to new space...");
    await switchSpace(name);
  } else {
    UIHelper.success(`Space "${UIHelper.highlight(name)}" added successfully!`);
    UIHelper.info("Use " + UIHelper.command(`dss switch ${name}`) + " to activate it.");
  }
}

export async function listSpaces() {
  await ensureConfigFileExists();

  const config: IConfig = await fs.readJson(configPath);

  if (config.spaces.length === 0) {
    UIHelper.warning("No spaces have been added yet.");
    UIHelper.info("Use " + UIHelper.command("dss add") + " to create your first space.");
    return;
  }

  UIHelper.printHeader("Your Development Spaces");
  UIHelper.printSpaceTable(config.spaces, config.activeSpace);
  
  if (config.activeSpace) {
    UIHelper.success(`Currently active: ${UIHelper.highlight(config.activeSpace)}`);
  }
  
  console.log(UIHelper.dim(`\n💡 Use ${UIHelper.command("dss switch")} to change active space`));
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
    UIHelper.warning("No spaces have been added yet.");
    UIHelper.info("Use " + UIHelper.command("dss add") + " to create your first space.");
    return;
  }

  let selectedSpaceName = spaceNameProvided;
  
  if (!selectedSpaceName) {
    UIHelper.printHeader("Switch Development Space");
    UIHelper.printKeyInstruction();
    
    // Use enhanced selection with fuzzy search
    selectedSpaceName = await select({
      message: "Choose a space to switch to:",
      choices: config.spaces.map((space) => ({
        name: space.name === config.activeSpace ? UIHelper.activeSpace(space.name) : UIHelper.inactiveSpace(space.name),
        value: space.name,
        description: `${space.email} (${space.userName})`
      })),
    }).catch(() => null);
  }
  
  if (!selectedSpaceName) return;

  const space = config.spaces.find((s) => s.name === selectedSpaceName);
  if (!space || !space.sshKeyPath) {
    UIHelper.error(`Space "${selectedSpaceName}" not found or does not have an associated SSH key.`);
    UIHelper.info("Available spaces:");
    config.spaces.forEach(s => {
      console.log(`  • ${UIHelper.highlight(s.name)} (${s.email})`);
    });
    return;
  }

  if (config.activeSpace === selectedSpaceName) {
    UIHelper.warning(`Space "${UIHelper.highlight(selectedSpaceName)}" is already active.`);
    return;
  }

  try {
    UIHelper.printProgress("Switching to space");
    
    // Set Git configuration
    execSync(`git config --global user.name "${space.userName}"`);
    execSync(`git config --global user.email "${space.email}"`);
    UIHelper.success(`Git user set to ${UIHelper.highlight(space.userName)} <${UIHelper.highlight(space.email)}>.`);

    // Add SSH key to the ssh-agent
    const addKeyCommand = `ssh-add ${space.sshKeyPath}`;
    execSync(addKeyCommand);
    UIHelper.success(`SSH key added to ssh-agent successfully.`);

    config.activeSpace = space.name;

    await setGitHubSSHKey(space.sshKeyPath);
    await fs.writeJson(configPath, config);
    
    UIHelper.clearProgress();
    UIHelper.printSuccessBox("Space Activated", [
      `✓ Switched to: ${space.name}`,
      `✓ Git user: ${space.userName}`,
      `✓ Email: ${space.email}`,
      `✓ SSH key: activated`
    ]);

    const confirmTest = await confirm({
      message: "Test GitHub access for this space?",
      default: false,
    });
  
    if (confirmTest) {
      await testGithubAccess(space.sshKeyPath);
    }

    console.log(""); // Add spacing
    await listSpaces();
  } catch (error) {
    UIHelper.clearProgress();
    UIHelper.error(`Failed to switch to space "${selectedSpaceName}": ${(error as Error).message}`);
  }
}

export async function removeSpace() {
  await ensureConfigFileExists();
  const config: IConfig = await fs.readJson(configPath);

  if (config.spaces.length === 0) {
    UIHelper.warning("No spaces have been added yet.");
    UIHelper.info("Use " + UIHelper.command("dss add") + " to create your first space.");
    return;
  }

  UIHelper.printHeader("Remove Development Space");
  UIHelper.warning("This action cannot be undone!");
  
  const spaceName = await select({
    message: "Select a space to remove:",
    choices: config.spaces.map((space) => ({
      name: space.name === config.activeSpace ? UIHelper.activeSpace(space.name) + " (active)" : space.name,
      value: space.name,
      description: `${space.email} (${space.userName})`
    })),
  });

  if (spaceName === config.activeSpace) {
    UIHelper.error(`Cannot remove the active space '${UIHelper.highlight(spaceName)}'.`);
    UIHelper.info("Please switch to another space first using " + UIHelper.command("dss switch") + ".");
    return;
  }

  const spaceToRemove = config.spaces.find((space) => space.name === spaceName);
  if (!spaceToRemove) return;

  // Show details of what will be removed
  console.log(UIHelper.dim("\nSpace to be removed:"));
  console.log(`  Name: ${UIHelper.highlight(spaceToRemove.name)}`);
  console.log(`  Email: ${spaceToRemove.email}`);
  console.log(`  User: ${spaceToRemove.userName}`);
  console.log(`  SSH Key: ${UIHelper.filename(spaceToRemove.sshKeyPath)}`);

  const confirmRemoval = await confirm({
    message: `Are you absolutely sure you want to remove '${spaceName}'?`,
    default: false,
  });

  if (!confirmRemoval) {
    UIHelper.info("Removal cancelled.");
    return;
  }

  try {
    UIHelper.printProgress("Removing space");
    
    // Remove SSH key from agent
    await removeSSHKeyFromAgent(spaceToRemove.sshKeyPath);

    // Remove from config
    config.spaces = config.spaces.filter((space) => space.name !== spaceName);
    await fs.writeJson(configPath, config);
    
    UIHelper.clearProgress();
    UIHelper.success(`Space '${UIHelper.highlight(spaceName)}' has been removed successfully.`);
    
    // Show remaining spaces
    if (config.spaces.length > 0) {
      console.log(UIHelper.dim("\nRemaining spaces:"));
      config.spaces.forEach(space => {
        console.log(`  • ${UIHelper.highlight(space.name)} (${space.email})`);
      });
    } else {
      UIHelper.info("No spaces remaining. Use " + UIHelper.command("dss add") + " to create a new one.");
    }
  } catch (error) {
    UIHelper.clearProgress();
    UIHelper.error(`Failed to remove space: ${(error as Error).message}`);
  }
}

export async function testSpace(spaceName?: SpaceNameArg) {
  spaceName = spaceName ? typeof spaceName === "string" ? spaceName : spaceName?.name : null;

  await ensureConfigFileExists();
  const config: IConfig = await fs.readJson(configPath);

  if (config.spaces.length === 0) {
    console.log("⚠️ No spaces have been added yet.");
    return;
  }

  const space = spaceName && config.spaces.find(s => s.name === spaceName) || config.spaces.find(s => s.name === config.activeSpace);

  if (!space) {
    console.log(spaceName ? `Space "${spaceName}" not found.` : `Active space "${config.activeSpace}" not found.`);
    return;
  }

  if (!space.sshKeyPath) {
    console.log(
      `Active space "${config.activeSpace}" does not have an associated SSH key.`
    );
    return;
  }

  await testGithubAccess(space.sshKeyPath);
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
