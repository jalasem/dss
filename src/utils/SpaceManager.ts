import { execSync } from "child_process";
import { input, confirm, select } from "@inquirer/prompts";
import os from "os";
import fs from "fs-extra";
import path from "path";
import { generateSSHKey } from "./sshKeyGen";
import { copyToClipboard, removeSSHKeyFromAgent, setGitHubSSHKey, testGithubAccess } from ".";
import { IConfig, ISpace, SpaceNameArg } from "./types";
import { UIHelper } from "./ui";
// import { FuzzySpaceSearch } from "./fuzzySearch";
import { promisify } from 'util';
const execAsync = promisify(require('child_process').exec);

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
}

export async function switchSpace(
  spaceName?: string | { name: string },
  options?: { dryRun?: boolean }
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

  // Check for dry-run mode
  if (options?.dryRun) {
    UIHelper.printInfoBox("Dry Run: Switch Space Preview", [
      `✓ Would switch to: ${space.name}`,
      `✓ Would set Git user: ${space.userName}`,
      `✓ Would set Git email: ${space.email}`,
      `✓ Would activate SSH key: ${space.sshKeyPath}`,
      `✓ Would update SSH config for GitHub`,
      `✓ Would save configuration`,
      '',
      'Use without --dry-run to apply changes'
    ]);
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

export async function removeSpace(spaceName?: string, options?: { dryRun?: boolean }) {
  await ensureConfigFileExists();
  const config: IConfig = await fs.readJson(configPath);

  if (config.spaces.length === 0) {
    UIHelper.warning("No spaces have been added yet.");
    UIHelper.info("Use " + UIHelper.command("dss add") + " to create your first space.");
    return;
  }

  UIHelper.printHeader("Remove Development Space");
  if (!options?.dryRun) {
    UIHelper.warning("This action cannot be undone!");
  }
  
  let selectedSpaceName = spaceName;
  if (!selectedSpaceName) {
    selectedSpaceName = await select({
      message: "Select a space to remove:",
      choices: config.spaces.map((space) => ({
        name: space.name === config.activeSpace ? UIHelper.activeSpace(space.name) + " (active)" : space.name,
        value: space.name,
        description: `${space.email} (${space.userName})`
      })),
    });
  }

  if (selectedSpaceName === config.activeSpace) {
    UIHelper.error(`Cannot remove the active space '${UIHelper.highlight(selectedSpaceName)}'.`);
    UIHelper.info("Please switch to another space first using " + UIHelper.command("dss switch") + ".");
    return;
  }

  const spaceToRemove = config.spaces.find((space) => space.name === selectedSpaceName);
  if (!spaceToRemove) return;

  // Show details of what will be removed
  console.log(UIHelper.dim("\nSpace to be removed:"));
  console.log(`  Name: ${UIHelper.highlight(spaceToRemove.name)}`);
  console.log(`  Email: ${spaceToRemove.email}`);
  console.log(`  User: ${spaceToRemove.userName}`);
  console.log(`  SSH Key: ${UIHelper.filename(spaceToRemove.sshKeyPath)}`);

  // Check for dry-run mode
  if (options?.dryRun) {
    UIHelper.printInfoBox("Dry Run: Remove Space Preview", [
      `✓ Would remove space: ${spaceToRemove.name}`,
      `✓ Would remove from configuration`,
      `✓ Would remove SSH key from agent`,
      `✓ SSH key files would remain on disk`,
      '',
      'Use without --dry-run to actually remove'
    ]);
    return;
  }

  const confirmRemoval = await confirm({
    message: `Are you absolutely sure you want to remove '${selectedSpaceName}'?`,
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
    config.spaces = config.spaces.filter((space) => space.name !== selectedSpaceName);
    await fs.writeJson(configPath, config);
    
    UIHelper.clearProgress();
    UIHelper.success(`Space '${UIHelper.highlight(selectedSpaceName)}' has been removed successfully.`);
    
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
    UIHelper.warning("No spaces have been added yet.");
    UIHelper.info("Use " + UIHelper.command("dss add") + " to create your first space.");
    return;
  }

  const space = spaceName && config.spaces.find(s => s.name === spaceName) || config.spaces.find(s => s.name === config.activeSpace);

  if (!space) {
    UIHelper.error(spaceName ? `Space "${spaceName}" not found.` : `Active space "${config.activeSpace}" not found.`);
    return;
  }

  if (!space.sshKeyPath) {
    UIHelper.warning(
      `Active space "${config.activeSpace}" does not have an associated SSH key.`
    );
    UIHelper.info("Use " + UIHelper.command("dss edit " + space.name) + " to configure SSH keys.");
    return;
  }

  await testGithubAccess(space.sshKeyPath);
}

export async function modifySpace() {
  await ensureConfigFileExists();
  const config: IConfig = await fs.readJson(configPath);

  if (config.spaces.length === 0) {
    UIHelper.warning("No spaces have been added yet.");
    UIHelper.info("Use " + UIHelper.command("dss add") + " to create your first space.");
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
    UIHelper.error(`Space "${selectedSpace}" not found.`);
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
      UIHelper.error(`Another space with the name "${spaceName}" already exists.`);
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
  if (isUpdateMade) {
    UIHelper.success(`Space "${UIHelper.highlight(selectedSpace)}" updated successfully.`);
  } else {
    UIHelper.info("No changes were made to the space.");
  }
}

export async function inspectSpace(spaceName?: string): Promise<void> {
  await ensureConfigFileExists();
  const config: IConfig = await fs.readJson(configPath);

  if (config.spaces.length === 0) {
    UIHelper.warning("No spaces have been added yet.");
    UIHelper.info("Use " + UIHelper.command("dss add") + " to create your first space.");
    return;
  }

  let selectedSpaceName = spaceName;
  if (!selectedSpaceName) {
    selectedSpaceName = await select({
      message: "Select a space to inspect:",
      choices: config.spaces.map((space) => ({
        name: space.name === config.activeSpace ? UIHelper.activeSpace(space.name) : space.name,
        value: space.name,
        description: `${space.email} (${space.userName})`
      })),
    });
  }

  const space = config.spaces.find((s) => s.name === selectedSpaceName);
  if (!space) {
    UIHelper.error(`Space "${selectedSpaceName}" not found.`);
    return;
  }

  UIHelper.printHeader(`Space Details: ${space.name}`);
  
  // Basic Information
  console.log(UIHelper.bold("Basic Information:"));
  UIHelper.printStatus("Name", space.name, space.name === config.activeSpace ? 'success' : 'info');
  UIHelper.printStatus("Email", space.email, 'info');
  UIHelper.printStatus("Username", space.userName, 'info');
  UIHelper.printStatus("Status", space.name === config.activeSpace ? 'Active' : 'Inactive', space.name === config.activeSpace ? 'success' : 'info');
  
  console.log("");
  
  // SSH Key Status
  console.log(UIHelper.bold("SSH Configuration:"));
  
  if (space.sshKeyPath) {
    const keyExists = await fs.pathExists(space.sshKeyPath);
    const pubKeyExists = await fs.pathExists(`${space.sshKeyPath}.pub`);
    
    UIHelper.printStatus("SSH Key Path", space.sshKeyPath, keyExists ? 'success' : 'error');
    UIHelper.printStatus("Private Key", keyExists ? 'Found' : 'Missing', keyExists ? 'success' : 'error');
    UIHelper.printStatus("Public Key", pubKeyExists ? 'Found' : 'Missing', pubKeyExists ? 'success' : 'error');
    
    // Check if key is loaded in ssh-agent
    try {
      const { stdout } = await execAsync('ssh-add -l');
      const keyInAgent = stdout.includes(space.sshKeyPath) || stdout.includes('no identities') === false;
      UIHelper.printStatus("SSH Agent", keyInAgent ? 'Key loaded' : 'Key not loaded', keyInAgent ? 'success' : 'warning');
    } catch {
      UIHelper.printStatus("SSH Agent", 'Unable to check', 'warning');
    }
    
    // Check SSH config
    const sshConfigPath = path.join(os.homedir(), '.ssh', 'config');
    if (await fs.pathExists(sshConfigPath)) {
      const sshConfig = await fs.readFile(sshConfigPath, 'utf8');
      const hasGithubConfig = sshConfig.includes('Host github.com');
      const usesThisKey = sshConfig.includes(space.sshKeyPath);
      UIHelper.printStatus("SSH Config", hasGithubConfig ? (usesThisKey ? 'Configured for this key' : 'Configured for different key') : 'No GitHub config', hasGithubConfig ? (usesThisKey ? 'success' : 'warning') : 'warning');
    } else {
      UIHelper.printStatus("SSH Config", 'No SSH config file', 'warning');
    }
    
    // Check key file permissions
    if (keyExists) {
      try {
        const stats = await fs.stat(space.sshKeyPath);
        const permissions = (stats.mode & parseInt('777', 8)).toString(8);
        const isSecure = permissions === '600';
        UIHelper.printStatus("Key Permissions", permissions, isSecure ? 'success' : 'warning');
      } catch {
        UIHelper.printStatus("Key Permissions", 'Unable to check', 'warning');
      }
    }
  } else {
    UIHelper.printStatus("SSH Key", 'Not configured', 'error');
  }
  
  console.log("");
  
  // Git Status
  console.log(UIHelper.bold("Git Configuration:"));
  
  try {
    const currentGitUser = execSync('git config --global user.name', { encoding: 'utf8' }).trim();
    const currentGitEmail = execSync('git config --global user.email', { encoding: 'utf8' }).trim();
    
    const userMatches = currentGitUser === space.userName;
    const emailMatches = currentGitEmail === space.email;
    
    UIHelper.printStatus("Git User", currentGitUser, userMatches ? 'success' : 'warning');
    UIHelper.printStatus("Git Email", currentGitEmail, emailMatches ? 'success' : 'warning');
    
    if (userMatches && emailMatches) {
      UIHelper.printStatus("Git Config", 'Matches this space', 'success');
    } else {
      UIHelper.printStatus("Git Config", 'Does not match this space', 'warning');
    }
  } catch {
    UIHelper.printStatus("Git Config", 'Unable to check', 'warning');
  }
  
  console.log("");
  
  // File System Info
  console.log(UIHelper.bold("File System:"));
  
  if (space.sshKeyPath) {
    const keyDir = path.dirname(space.sshKeyPath);
    const keyDirExists = await fs.pathExists(keyDir);
    UIHelper.printStatus("Key Directory", keyDir, keyDirExists ? 'success' : 'error');
    
    if (keyDirExists) {
      try {
        const files = await fs.readdir(keyDir);
        const keyFiles = files.filter(file => file.includes(path.basename(space.sshKeyPath)));
        UIHelper.printStatus("Key Files", `${keyFiles.length} files found`, keyFiles.length >= 2 ? 'success' : 'warning');
      } catch {
        UIHelper.printStatus("Key Files", 'Unable to check', 'warning');
      }
    }
  }
  
  console.log("");
  
  // Action suggestions
  console.log(UIHelper.bold("Available Actions:"));
  console.log(UIHelper.dim("  • " + UIHelper.command(`dss switch ${space.name}`) + " - Switch to this space"));
  console.log(UIHelper.dim("  • " + UIHelper.command(`dss edit ${space.name}`) + " - Edit space configuration"));
  console.log(UIHelper.dim("  • " + UIHelper.command(`dss test ${space.name}`) + " - Test GitHub access"));
  
  if (space.name !== config.activeSpace) {
    console.log(UIHelper.dim("  • " + UIHelper.command(`dss remove ${space.name}`) + " - Remove this space"));
  }
}

export async function onboardUser(): Promise<void> {
  UIHelper.printHeader("🎉 Welcome to DSS (Dev Spaces Switcher)");
  
  console.log(UIHelper.dim("Let's get you set up with your first development space!"));
  console.log("");
  
  // Check if user already has spaces
  await ensureConfigFileExists();
  const config: IConfig = await fs.readJson(configPath);
  
  if (config.spaces.length > 0) {
    UIHelper.info(`You already have ${config.spaces.length} space(s) configured.`);
    const continueOnboarding = await confirm({
      message: "Would you like to continue with the onboarding tutorial?",
      default: false
    });
    
    if (!continueOnboarding) {
      UIHelper.info("Onboarding cancelled. Use " + UIHelper.command("dss list") + " to see your spaces.");
      return;
    }
  }
  
  // Introduction
  UIHelper.printInfoBox("What is DSS?", [
    "DSS helps you manage multiple development identities by:",
    "• Switching between different Git configurations",
    "• Managing separate SSH keys for different accounts",
    "• Organizing your development environments",
    "• Testing GitHub access for each identity"
  ]);
  
  const startTutorial = await confirm({
    message: "Ready to create your first development space?",
    default: true
  });
  
  if (!startTutorial) {
    UIHelper.info("You can start the onboarding anytime with " + UIHelper.command("dss onboard"));
    return;
  }
  
  // Step 1: Create first space
  console.log("");
  UIHelper.printHeader("📝 Step 1: Create Your First Space");
  
  console.log(UIHelper.dim("A 'space' represents a development identity with its own:"));
  console.log(UIHelper.dim("• Git username and email"));
  console.log(UIHelper.dim("• SSH key for GitHub authentication"));
  console.log(UIHelper.dim("• Isolated configuration"));
  console.log("");
  
  const createFirstSpace = await confirm({
    message: "Create your first space now?",
    default: true
  });
  
  if (createFirstSpace) {
    await addSpace();
    
    // Refresh config
    const updatedConfig: IConfig = await fs.readJson(configPath);
    if (updatedConfig.spaces.length === 0) {
      UIHelper.warning("Space creation was cancelled. You can try again with " + UIHelper.command("dss add"));
      return;
    }
  } else {
    UIHelper.info("You can create a space later with " + UIHelper.command("dss add"));
  }
  
  // Step 2: Explain switching
  console.log("");
  UIHelper.printHeader("🔄 Step 2: Understanding Space Switching");
  
  UIHelper.printInfoBox("What happens when you switch spaces?", [
    "1. Git global config is updated with space's user/email",
    "2. SSH key is added to ssh-agent",
    "3. SSH config is updated for GitHub",
    "4. Space becomes 'active' for your development work"
  ]);
  
  const demoSwitch = await confirm({
    message: "Would you like to see the switch command in action?",
    default: true
  });
  
  if (demoSwitch) {
    console.log("");
    UIHelper.info("Here's how to switch spaces:");
    console.log(UIHelper.dim("  • " + UIHelper.command("dss switch") + " - Interactive selection"));
    console.log(UIHelper.dim("  • " + UIHelper.command("dss switch <space-name>") + " - Direct switch"));
    console.log(UIHelper.dim("  • " + UIHelper.command("dss switch --dry-run") + " - Preview changes"));
    
    const trySwitch = await confirm({
      message: "Try switching to your new space?",
      default: true
    });
    
    if (trySwitch) {
      await switchSpace();
    }
  }
  
  // Step 3: Essential commands
  console.log("");
  UIHelper.printHeader("📚 Step 3: Essential Commands");
  
  console.log(UIHelper.bold("Core Commands:"));
  console.log(UIHelper.dim("  • " + UIHelper.command("dss list") + " - View all your spaces"));
  console.log(UIHelper.dim("  • " + UIHelper.command("dss switch") + " - Change active space"));
  console.log(UIHelper.dim("  • " + UIHelper.command("dss test") + " - Test GitHub access"));
  console.log(UIHelper.dim("  • " + UIHelper.command("dss inspect <space>") + " - Detailed space info"));
  
  console.log("");
  console.log(UIHelper.bold("Management Commands:"));
  console.log(UIHelper.dim("  • " + UIHelper.command("dss add") + " - Create new space"));
  console.log(UIHelper.dim("  • " + UIHelper.command("dss edit") + " - Modify existing space"));
  console.log(UIHelper.dim("  • " + UIHelper.command("dss remove") + " - Delete space"));
  
  console.log("");
  console.log(UIHelper.bold("Advanced Commands:"));
  console.log(UIHelper.dim("  • " + UIHelper.command("dss batch") + " - Switch between multiple spaces"));
  console.log(UIHelper.dim("  • " + UIHelper.command("dss bulk") + " - Bulk update operations"));
  console.log(UIHelper.dim("  • " + UIHelper.command("dss export/import") + " - Backup/restore config"));
  
  // Step 4: Next steps
  console.log("");
  UIHelper.printHeader("🚀 Step 4: Next Steps");
  
  const nextSteps = [
    "1. Add your SSH key to GitHub at https://github.com/settings/keys",
    "2. Test your GitHub access with " + UIHelper.command("dss test"),
    "3. Create additional spaces for different projects/companies",
    "4. Use " + UIHelper.command("dss list") + " to see all your spaces",
    "5. Switch between spaces as needed for your work"
  ];
  
  UIHelper.printSuccessBox("You're all set!", nextSteps);
  
  const testGitHub = await confirm({
    message: "Would you like to test GitHub access now?",
    default: true
  });
  
  if (testGitHub) {
    await testSpace();
  }
  
  console.log("");
  UIHelper.success("Onboarding complete! 🎉");
  UIHelper.info("Use " + UIHelper.command("dss --help") + " anytime to see all available commands.");
}
