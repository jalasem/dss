import { execFile } from "child_process";
import { input, confirm, select } from "@inquirer/prompts";
import os from "os";
import fs from "fs-extra";
import path from "path";
import { generateKey } from "../infra/keys";
import { copyToClipboard } from "../infra/clipboard";
import { addToAgent, removeSSHKeyFromAgent, setHostSSHKey, testHostAccess } from "../infra/ssh";
import { getGitUser, writeActiveGitconfig, ensureGlobalInclude } from "../infra/git";
import { bindRepository } from "../infra/repoBinding";
import { isPromptExitError, safeConfirm, safePassword, promptHost } from "./prompts";
import { ISpace, IKeyInfo, IStoreV2 } from "../core/types";
import { keySettingsUrl } from "../core/hosts";
import { UIHelper } from "./ui";
import { fail } from "./fail";
import { slugify, findSpace, validateIdentityName } from "../core/identity";
import { loadConfig, persistConfig, saveStore, setIdentityKey } from "../infra/store";
import { promisify } from 'util';
const execFileAsync = promisify(execFile);

// A userName/email reaches writeActiveGitconfig (src/infra/git.ts), which
// hard-rejects an embedded \n/\r as a defense-in-depth last line — but the
// prompt layer should catch it first so the failure surfaces as a normal
// re-prompt instead of a mid-flow fail(). Kept in sync in spirit, not code,
// with writeActiveGitconfig's own guard.
function containsLineBreak(value: string): boolean {
  return /[\r\n]/.test(value);
}

/**
 * Re-applies the DSS-managed global identity for `space`: active.gitconfig
 * (+ the global include) and, when the identity has a key, the ~/.ssh/config
 * Host block for it. A no-op unless `space` IS (still) the store's active
 * identity — safe/idempotent to call unconditionally after any edit to an
 * identity that might or might not be the active one (rename, bulk update,
 * key rotation, ...), rather than requiring every caller to duplicate the
 * active check.
 *
 * Deliberately does NOT touch repo-local bindings (`dss bind`) — those are
 * refreshed separately, independent of whether the identity is the
 * globally-active one (see modifySpace's own binding-refresh loop).
 */
export async function reapplyActiveIdentity(space: ISpace, store: IStoreV2): Promise<void> {
  if (!store.active || slugify(store.active) !== slugify(space.name)) return;

  await writeActiveGitconfig(space);
  await ensureGlobalInclude();
  if (space.sshKeyPath) {
    await setHostSSHKey(space.sshKeyPath, space.host ?? 'github.com');
  }
}

export async function addSpace() {
  UIHelper.printHeader("Create New Development Space");
  UIHelper.info("Please provide the following information:");

  const name = await input({
    message: "Space name:",
    validate: (input) => validateIdentityName(input),
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
      if (containsLineBreak(input)) return "User name cannot contain line breaks";
      return true;
    },
  });

  const host = await promptHost();

  const shouldGenerateKey = await confirm({
    message: "Generate a new SSH key for this space?",
    default: true,
  });

  const passphrase = shouldGenerateKey
    ? await safePassword({ message: "Passphrase for the key (empty for none):" })
    : "";

  const { store, config, originalBySpace } = await loadConfig();
  const slugifiedSpaceName = slugify(name);

  if (findSpace(config, slugifiedSpaceName)) {
    fail(`A space with the name "${name}" already exists.`);
    UIHelper.info("Please choose a different name or use " + UIHelper.command("dss edit") + " to modify the existing space.");
    return;
  }

  let sshKeyPath = "";
  let generatedKeyInfo: IKeyInfo | undefined;
  if (shouldGenerateKey) {
    UIHelper.printProgress("Generating SSH key");
    const keyDirectory = path.join(os.homedir(), ".dss", "spaces", slugifiedSpaceName);
    generatedKeyInfo = await generateKey({
      directory: keyDirectory,
      algorithm: "ed25519",
      comment: email,
      passphrase,
    });
    sshKeyPath = generatedKeyInfo.path;
    UIHelper.clearProgress();

    const publicKeyPath = `${sshKeyPath}.pub`;

    try {
      const publicKey = await fs.readFile(publicKeyPath, "utf8");
      await copyToClipboard(publicKey);

      UIHelper.success("SSH key generated successfully!");
      const settingsUrl = keySettingsUrl(host);
      UIHelper.printSuccessBox("SSH Key Ready", [
        "Public key copied to clipboard",
        `Add it to your ${host} account`,
        settingsUrl ? `${host} SSH Keys: ${settingsUrl}` : `Add the public key to your ${host} account.`
      ]);

      console.log(UIHelper.dim("\nPublic SSH Key:"));
      console.log(UIHelper.highlight(publicKey));
    } catch (err) {
      // The space was still created successfully — a clipboard/read failure
      // here is cosmetic, not terminal, so warn rather than fail().
      UIHelper.warning(
        "Failed to read the public SSH key or copy it to the clipboard: " +
        (err as Error).message
      );
    }
  }

  const newSpace: ISpace = {
    name: slugifiedSpaceName,
    email,
    userName,
    host,
    sshKeyPath,
  };

  config.spaces.push(newSpace);
  await persistConfig(store, config, originalBySpace);

  // persistConfig writes identities through the ISpace view, which can't
  // carry a key's fingerprint/createdAt — set the full metadata directly.
  if (generatedKeyInfo) {
    setIdentityKey(store, slugifiedSpaceName, generatedKeyInfo);
    await saveStore(store);
  }

  const switchToNewSpace = await confirm({
    message: `Do you want to switch to the newly added space "${slugifiedSpaceName}" now?`,
    default: true,
  });

  if (switchToNewSpace) {
    UIHelper.info("Switching to new space...");
    await switchSpace(slugifiedSpaceName);
  } else {
    UIHelper.success(`Space "${UIHelper.highlight(slugifiedSpaceName)}" added successfully!`);
    UIHelper.info("Use " + UIHelper.command(`dss switch ${slugifiedSpaceName}`) + " to activate it.");
  }
}

export async function listSpaces() {
  const { config } = await loadConfig();

  if (config.spaces.length === 0) {
    UIHelper.warning("No spaces have been added yet.");
    UIHelper.info("Use " + UIHelper.command("dss add") + " to create your first space.");
    return;
  }

  UIHelper.printHeader("Your Development Spaces");
  UIHelper.printSpaceTable(config.spaces, config.activeSpace);
}

export async function switchSpace(
  spaceName?: string,
  options?: { dryRun?: boolean }
): Promise<void> {
  const { store, config, originalBySpace } = await loadConfig();

  if (config.spaces.length === 0) {
    UIHelper.warning("No spaces have been added yet.");
    UIHelper.info("Use " + UIHelper.command("dss add") + " to create your first space.");
    return;
  }

  let selectedSpaceName = spaceName;

  if (!selectedSpaceName) {
    UIHelper.printHeader("Switch Development Space");

    // Use enhanced selection with fuzzy search
    selectedSpaceName = await select({
      message: "Choose a space to switch to:",
      choices: config.spaces.map((space) => ({
        name: space.name === config.activeSpace ? UIHelper.activeSpace(space.name) : UIHelper.inactiveSpace(space.name),
        value: space.name,
        description: `${space.email} (${space.userName})`
      })),
    }).catch((error) => {
      if (isPromptExitError(error)) return undefined;
      throw error;
    });
  }

  if (!selectedSpaceName) return;

  const space = findSpace(config, selectedSpaceName);
  if (!space) {
    fail(`Space "${selectedSpaceName}" not found.`);
    UIHelper.info("Available spaces:");
    config.spaces.forEach(s => {
      console.log(`  · ${UIHelper.highlight(s.name)} (${s.email})`);
    });
    return;
  }

  if (config.activeSpace === space.name) {
    UIHelper.warning(`Space "${UIHelper.highlight(space.name)}" is already active.`);
    return;
  }

  const hasKey = Boolean(space.sshKeyPath);
  const host = space.host ?? 'github.com';

  // Check for dry-run mode
  if (options?.dryRun) {
    const previewLines = [
      `Would switch to: ${space.name}`,
      `Would set Git user: ${space.userName}`,
      `Would set Git email: ${space.email}`,
    ];
    if (hasKey) {
      previewLines.push(
        `Would activate SSH key: ${space.sshKeyPath}`,
        `Would update SSH config for ${host}`
      );
    } else {
      previewLines.push(`No key configured — key activation steps would be skipped`);
    }
    previewLines.push(`Would save configuration`, 'Use without --dry-run to apply changes');
    UIHelper.printInfoBox("Dry Run: Switch Space Preview", previewLines);
    return;
  }

  try {
    UIHelper.printProgress("Switching to space");

    // Set Git configuration (includeIf-first: write the DSS-managed
    // active.gitconfig and make sure the user's global config includes it,
    // rather than writing user.name/user.email directly).
    await writeActiveGitconfig(space);
    await ensureGlobalInclude();
    UIHelper.success(`Git user set to ${UIHelper.highlight(space.userName)} <${UIHelper.highlight(space.email)}>.`);

    if (hasKey) {
      // Add SSH key to the ssh-agent. Not terminal: core.sshCommand's `-i
      // <path>` means git SSH no longer depends on the agent, so an
      // agent-less environment (CI, containers, a fresh login) shouldn't
      // abort the switch — warn and continue instead of fail()ing (which
      // would leave the global git identity already changed but
      // config.activeSpace un-persisted, an inconsistent state).
      try {
        await addToAgent(space.sshKeyPath);
        UIHelper.success(`SSH key added to ssh-agent successfully.`);
      } catch (error) {
        UIHelper.warning(`Could not add the SSH key to the ssh-agent: ${(error as Error).message}`);
      }
      await setHostSSHKey(space.sshKeyPath, host);
    } else {
      UIHelper.warning(
        `Space "${space.name}" has no SSH key — Git identity switched, SSH config unchanged. ` +
        `Use ${UIHelper.command('dss bulk')} (regenerate SSH keys) to add one.`
      );
    }

    config.activeSpace = space.name;
    await persistConfig(store, config, originalBySpace);

    UIHelper.clearProgress();
    UIHelper.printSuccessBox("Space Activated", [
      `Switched to: ${space.name}`,
      `Git user: ${space.userName}`,
      `Email: ${space.email}`,
      hasKey ? `SSH key: activated` : `SSH key: none`
    ]);

    if (hasKey) {
      // safeConfirm: this runs AFTER the switch already succeeded and
      // persisted, so a closed prompt (Ctrl+C / non-TTY) must not surface
      // as a command failure — a raw confirm() throwing ExitPromptError
      // here would fall into the catch below and fail() the whole command
      // after the real work is already done.
      const confirmTest = await safeConfirm({
        message: `Test SSH access to ${host} for this space?`,
        default: false,
      });

      if (confirmTest) {
        await testHostAccess(space.sshKeyPath, host);
      }
    }

    console.log(""); // Add spacing
    await listSpaces();
  } catch (error) {
    UIHelper.clearProgress();
    fail(`Failed to switch to space "${selectedSpaceName}": ${(error as Error).message}`);
  }
}

export async function removeSpace(spaceName?: string, options?: { dryRun?: boolean }) {
  const { store, config, originalBySpace } = await loadConfig();

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

  const spaceToRemove = findSpace(config, selectedSpaceName);
  if (!spaceToRemove) {
    fail(`Space "${selectedSpaceName}" not found.`);
    return;
  }

  if (spaceToRemove.name === config.activeSpace) {
    fail(`Cannot remove the active space '${UIHelper.highlight(spaceToRemove.name)}'.`);
    UIHelper.info("Please switch to another space first using " + UIHelper.command("dss switch") + ".");
    return;
  }

  // Show details of what will be removed
  console.log(UIHelper.dim("\nSpace to be removed:"));
  console.log(`  Name: ${UIHelper.highlight(spaceToRemove.name)}`);
  console.log(`  Email: ${spaceToRemove.email}`);
  console.log(`  User: ${spaceToRemove.userName}`);
  console.log(`  SSH Key: ${UIHelper.filename(spaceToRemove.sshKeyPath)}`);

  // Check for dry-run mode
  if (options?.dryRun) {
    const hasKey = Boolean(spaceToRemove.sshKeyPath);
    UIHelper.printInfoBox("Dry Run: Remove Space Preview", [
      `Would remove space: ${spaceToRemove.name}`,
      `Would remove from configuration`,
      hasKey ? `Would remove SSH key from agent` : `No SSH key configured — agent removal skipped`,
      `SSH key files would remain on disk`,
      'Use without --dry-run to actually remove'
    ]);
    return;
  }

  const confirmRemoval = await confirm({
    message: `Are you absolutely sure you want to remove '${spaceToRemove.name}'?`,
    default: false,
  });

  if (!confirmRemoval) {
    UIHelper.info("Removal cancelled.");
    return;
  }

  try {
    UIHelper.printProgress("Removing space");

    // Remove SSH key from agent
    if (spaceToRemove.sshKeyPath) {
      await removeSSHKeyFromAgent(spaceToRemove.sshKeyPath);
    }

    // Remove from config
    config.spaces = config.spaces.filter((space) => space.name !== spaceToRemove.name);
    await persistConfig(store, config, originalBySpace);

    UIHelper.clearProgress();
    UIHelper.success(`Space '${UIHelper.highlight(spaceToRemove.name)}' has been removed successfully.`);

    // Registered repo-local bindings aren't removed here — only `dss unbind`
    // clears a registry entry — so warn that they still reference this
    // now-gone identity's private file rather than silently leaving it.
    const orphanedBindings = store.bindings.filter(
      (binding) => slugify(binding.identity) === slugify(spaceToRemove.name)
    );
    if (orphanedBindings.length > 0) {
      UIHelper.warning(
        `${orphanedBindings.length} repositor${orphanedBindings.length === 1 ? 'y is' : 'ies are'} ` +
        `still bound to the removed identity "${spaceToRemove.name}":`
      );
      orphanedBindings.forEach((binding) => {
        console.log(`  · ${binding.path}`);
      });
      UIHelper.info(`Run ${UIHelper.command('dss unbind')} in each repository to clear the binding.`);
    }

    // Show remaining spaces
    if (config.spaces.length > 0) {
      console.log(UIHelper.dim("\nRemaining spaces:"));
      config.spaces.forEach(space => {
        console.log(`  · ${UIHelper.highlight(space.name)} (${space.email})`);
      });
    } else {
      UIHelper.info("No spaces remaining. Use " + UIHelper.command("dss add") + " to create a new one.");
    }
  } catch (error) {
    UIHelper.clearProgress();
    fail(`Failed to remove space: ${(error as Error).message}`);
  }
}

export async function testSpace(spaceName?: string) {
  const { config } = await loadConfig();

  if (config.spaces.length === 0) {
    UIHelper.warning("No spaces have been added yet.");
    UIHelper.info("Use " + UIHelper.command("dss add") + " to create your first space.");
    return;
  }

  const space = spaceName
    ? findSpace(config, spaceName)
    : config.spaces.find(s => s.name === config.activeSpace);

  if (!space) {
    fail(spaceName ? `Space "${spaceName}" not found.` : `Active space "${config.activeSpace}" not found.`);
    return;
  }

  if (!space.sshKeyPath) {
    UIHelper.warning(
      `Space "${space.name}" does not have an associated SSH key.`
    );
    UIHelper.info("Use " + UIHelper.command("dss bulk") + " (regenerate SSH keys) to configure SSH keys.");
    return;
  }

  await testHostAccess(space.sshKeyPath, space.host ?? 'github.com');
}

export async function modifySpace(spaceName?: string) {
  const { store, config, originalBySpace } = await loadConfig();

  if (config.spaces.length === 0) {
    UIHelper.warning("No spaces have been added yet.");
    UIHelper.info("Use " + UIHelper.command("dss add") + " to create your first space.");
    return;
  }

  const selectedSpace = spaceName ?? await select({
    message: "Which space would you like to modify?",
    choices: config.spaces.map((space) => ({
      name: space.name,
      value: space.name,
    })),
  });

  const space = findSpace(config, selectedSpace);
  if (!space) {
    fail(`Space "${selectedSpace}" not found.`);
    return;
  }

  const wasActive = space.name === config.activeSpace;
  const originalName = space.name;
  const originalEmail = space.email;
  const originalUserName = space.userName;
  const originalHost = space.host ?? 'github.com';
  const originalSshKeyPath = space.sshKeyPath;

  const newSpaceName = await input({
    message: `New name for "${space.name}" (leave blank to skip):`,
    default: space.name,
    validate: (input) => {
      // A name that's cosmetically different but slugifies the same (e.g.
      // retyping the current name, or a legacy raw name's normalized slug)
      // is a no-op rename — always allowed, even for a pre-existing name
      // that predates this validator. Only a genuine new name is checked.
      if (slugify(input) === slugify(space.name)) return true;
      return validateIdentityName(input);
    },
  });
  const email = await input({
    message: "New email (leave blank to skip):",
    default: space.email,
    validate: (input) => {
      if (!input.trim()) return "Email is required!";
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(input)) return "Please enter a valid email address";
      return true;
    },
  });
  const userName = await input({
    message: "New user name (leave blank to skip):",
    default: space.userName,
    validate: (input) => {
      if (!input.trim()) return "User name is required!";
      if (containsLineBreak(input)) return "User name cannot contain line breaks";
      return true;
    },
  });
  const host = await promptHost(originalHost);

  let isUpdateMade = false;
  let keyDirMoved = false;
  if (slugify(newSpaceName) !== slugify(space.name)) {
    const newSlug = slugify(newSpaceName);
    const isDuplicate = config.spaces.some(
      (s) => s !== space && slugify(s.name) === newSlug
    );
    if (isDuplicate) {
      fail(`Another space with the name "${newSpaceName}" already exists.`);
      return;
    }

    if (space.sshKeyPath) {
      const oldKeyDir = path.dirname(space.sshKeyPath);
      const newKeyDir = path.join(path.dirname(oldKeyDir), newSlug);
      if (oldKeyDir !== newKeyDir && await fs.pathExists(oldKeyDir)) {
        try {
          await fs.move(oldKeyDir, newKeyDir);
        } catch (error) {
          fail(`Failed to move key directory: ${(error as Error).message}`);
          return;
        }
        space.sshKeyPath = path.join(newKeyDir, path.basename(space.sshKeyPath));
        keyDirMoved = true;
      }
    }

    space.name = newSlug;
    if (wasActive) {
      config.activeSpace = newSlug;
    }
    isUpdateMade = true;
  }
  if (email !== originalEmail) {
    space.email = email;
    isUpdateMade = true;
  }
  if (userName !== originalUserName) {
    space.userName = userName;
    isUpdateMade = true;
  }
  if (host !== originalHost) {
    space.host = host;
    isUpdateMade = true;
  }

  // Registered repo-local bindings for this identity (matched by name,
  // slug-aware — the registry may hold a legacy raw name). A rename updates
  // each matching entry's `identity`; a rename/email/userName/key-path
  // change re-runs bindRepository against every live registered path so the
  // repo's private binding file (user/email/sshCommand) stays in sync. This
  // replaces Phase 1's blanket "may still reference the old key path"
  // warning for identities the registry actually knows about.
  const renamed = slugify(space.name) !== slugify(originalName);
  const matchingBindings = store.bindings.filter(
    (binding) => slugify(binding.identity) === slugify(originalName)
  );
  const bindingRefreshNeeded = renamed
    || space.email !== originalEmail
    || space.userName !== originalUserName
    || space.sshKeyPath !== originalSshKeyPath;

  if (matchingBindings.length > 0 && renamed) {
    matchingBindings.forEach((binding) => {
      binding.identity = space.name;
    });
  }

  // Persist before re-applying global git config / refreshing bindings so
  // disk (config + any moved key directory + renamed binding entries) stays
  // consistent even if either of those steps below fails.
  await persistConfig(store, config, originalBySpace);

  if (matchingBindings.length > 0) {
    if (bindingRefreshNeeded) {
      let refreshed = 0;
      let needsAttention = 0;
      for (const binding of matchingBindings) {
        try {
          await bindRepository(binding.path, space, {});
          refreshed++;
        } catch (error) {
          needsAttention++;
          UIHelper.warning(`Could not refresh binding for ${binding.path}: ${(error as Error).message}`);
        }
      }
      UIHelper.info(`Refreshed ${refreshed} binding(s); ${needsAttention} need attention.`);
    }
  } else if (keyDirMoved) {
    UIHelper.warning(
      `Repositories bound to this space via ${UIHelper.command('dss bind')} may still reference the old key path — ` +
      `re-bind them with ${UIHelper.command(`dss bind ${space.name}`)}.`
    );
  }

  // Unified with bindingRefreshNeeded (rename, email, userName, or key-path
  // change) rather than a separate email/userName-only check: active.gitconfig
  // carries the key's sshCommand too now, so a rename-only or key-path-only
  // edit of the ACTIVE identity must also re-apply it — otherwise it's left
  // pointing at a key path that may no longer exist (that file is globally
  // included and unconditional, so a stale sshCommand breaks git SSH for
  // every remote on the machine until the next `dss switch`). Delegates to
  // reapplyActiveIdentity, which also refreshes ~/.ssh/config's Host block —
  // without that, a rename that moves the key directory leaves ssh-config's
  // IdentityFile pointing at a gone path, and `switch <active>` early-returns
  // "already active" so it can never be repaired.
  if (wasActive && bindingRefreshNeeded) {
    try {
      await reapplyActiveIdentity(space, store);
    } catch (error) {
      fail(`Failed to update global git configuration: ${(error as Error).message}`);
      return;
    }
  }

  if (isUpdateMade) {
    UIHelper.success(`Space "${UIHelper.highlight(space.name)}" updated successfully.`);
  } else {
    UIHelper.info("No changes were made to the space.");
  }
}

export async function inspectSpace(spaceName?: string): Promise<void> {
  const { config } = await loadConfig();

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

  const space = findSpace(config, selectedSpaceName);
  if (!space) {
    fail(`Space "${selectedSpaceName}" not found.`);
    return;
  }

  UIHelper.printHeader(`Space Details: ${space.name}`);

  // Basic Information
  console.log(UIHelper.bold("Basic Information:"));
  UIHelper.printStatus("Name", space.name, space.name === config.activeSpace ? 'success' : 'info');
  UIHelper.printStatus("Email", space.email, 'info');
  UIHelper.printStatus("Username", space.userName, 'info');
  UIHelper.printStatus("Host", space.host ?? 'github.com', 'info');
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

    // Check if key is loaded in ssh-agent by comparing fingerprints
    try {
      const { stdout: fingerprintOutput } = await execFileAsync('ssh-keygen', ['-lf', `${space.sshKeyPath}.pub`]);
      const fingerprintMatch = fingerprintOutput.match(/SHA256:\S+/);
      const fingerprint = fingerprintMatch?.[0];

      const { stdout: agentOutput } = await execFileAsync('ssh-add', ['-l']);
      const keyInAgent = Boolean(fingerprint) && agentOutput.includes(fingerprint as string);
      UIHelper.printStatus("SSH Agent", keyInAgent ? 'Key loaded' : 'Key not loaded', keyInAgent ? 'success' : 'warning');
    } catch {
      UIHelper.printStatus("SSH Agent", 'Unable to check', 'warning');
    }

    // Check SSH config
    const sshConfigPath = path.join(os.homedir(), '.ssh', 'config');
    if (await fs.pathExists(sshConfigPath)) {
      const sshConfig = await fs.readFile(sshConfigPath, 'utf8');
      const configuredHost = space.host ?? 'github.com';
      const hasHostConfig = sshConfig.includes(`Host ${configuredHost}`);
      const usesThisKey = sshConfig.includes(space.sshKeyPath);
      UIHelper.printStatus("SSH Config", hasHostConfig ? (usesThisKey ? 'Configured for this key' : 'Configured for different key') : `No ${configuredHost} config`, hasHostConfig ? (usesThisKey ? 'success' : 'warning') : 'warning');
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
    const { userName: currentGitUser, email: currentGitEmail } = await getGitUser();

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
  console.log(UIHelper.dim("  · " + UIHelper.command(`dss switch ${space.name}`) + " - Switch to this space"));
  console.log(UIHelper.dim("  · " + UIHelper.command(`dss edit ${space.name}`) + " - Edit space configuration"));
  console.log(UIHelper.dim("  · " + UIHelper.command(`dss test ${space.name}`) + ` - Test SSH access to ${space.host ?? 'github.com'}`));

  if (space.name !== config.activeSpace) {
    console.log(UIHelper.dim("  · " + UIHelper.command(`dss remove ${space.name}`) + " - Remove this space"));
  }
}

export async function onboardUser(): Promise<void> {
  UIHelper.printHeader("Welcome to DSS (Dev Spaces Switcher)");

  console.log(UIHelper.dim("Let's get you set up with your first development space!"));
  console.log("");

  // Check if user already has spaces
  const { config } = await loadConfig();

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
    "Switching between different Git configurations",
    "Managing separate SSH keys for different accounts",
    "Organizing your development environments",
    "Testing GitHub access for each identity"
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
  UIHelper.printHeader("Step 1: Create Your First Space");

  console.log(UIHelper.dim("A 'space' represents a development identity with its own:"));
  console.log(UIHelper.dim("· Git username and email"));
  console.log(UIHelper.dim("· SSH key for GitHub authentication"));
  console.log(UIHelper.dim("· Isolated configuration"));
  console.log("");

  const createFirstSpace = await confirm({
    message: "Create your first space now?",
    default: true
  });

  if (createFirstSpace) {
    await addSpace();

    // Refresh config
    const { config: updatedConfig } = await loadConfig();
    if (updatedConfig.spaces.length === 0) {
      UIHelper.warning("Space creation was cancelled. You can try again with " + UIHelper.command("dss add"));
      return;
    }
  } else {
    UIHelper.info("You can create a space later with " + UIHelper.command("dss add"));
  }

  // Step 2: Explain switching
  console.log("");
  UIHelper.printHeader("Step 2: Understanding Space Switching");

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
    console.log(UIHelper.dim("  · " + UIHelper.command("dss switch") + " - Interactive selection"));
    console.log(UIHelper.dim("  · " + UIHelper.command("dss switch <space-name>") + " - Direct switch"));
    console.log(UIHelper.dim("  · " + UIHelper.command("dss switch --dry-run") + " - Preview changes"));

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
  UIHelper.printHeader("Step 3: Essential Commands");

  console.log(UIHelper.bold("Core Commands:"));
  console.log(UIHelper.dim("  · " + UIHelper.command("dss list") + " - View all your spaces"));
  console.log(UIHelper.dim("  · " + UIHelper.command("dss switch") + " - Change active space"));
  console.log(UIHelper.dim("  · " + UIHelper.command("dss test") + " - Test GitHub access"));
  console.log(UIHelper.dim("  · " + UIHelper.command("dss inspect <space>") + " - Detailed space info"));

  console.log("");
  console.log(UIHelper.bold("Management Commands:"));
  console.log(UIHelper.dim("  · " + UIHelper.command("dss add") + " - Create new space"));
  console.log(UIHelper.dim("  · " + UIHelper.command("dss edit") + " - Modify existing space"));
  console.log(UIHelper.dim("  · " + UIHelper.command("dss remove") + " - Delete space"));

  console.log("");
  console.log(UIHelper.bold("Advanced Commands:"));
  console.log(UIHelper.dim("  · " + UIHelper.command("dss batch") + " - Switch between multiple spaces"));
  console.log(UIHelper.dim("  · " + UIHelper.command("dss bulk") + " - Bulk update operations"));
  console.log(UIHelper.dim("  · " + UIHelper.command("dss export/import") + " - Backup/restore config"));

  // Step 4: Next steps
  console.log("");
  UIHelper.printHeader("Step 4: Next Steps");

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
  UIHelper.success("Onboarding complete!");
  UIHelper.info("Use " + UIHelper.command("dss --help") + " anytime to see all available commands.");
}
