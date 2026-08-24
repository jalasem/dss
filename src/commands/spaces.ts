import os from "os";
import fs from "fs-extra";
import path from "path";
import { generateKey } from "../infra/keys";
import { copyToClipboard } from "../infra/clipboard";
import { addToAgent, removeSSHKeyFromAgent, setHostSSHKey, testHostAccess } from "../infra/ssh";
import { writeActiveGitconfig, writeIdentityGitconfig, ensureGlobalInclude, activeGitconfigPath } from "../infra/git";
import { bindRepository } from "../infra/repoBinding";
import {
  isPromptExitError,
  safeConfirm,
  guardedInput,
  guardedSelect,
  guardedPassword,
  guardedPromptHost,
  guardedConfirm,
  isNonInteractive,
  assumeYes,
  validateCustomHost,
  UsageError,
} from "./prompts";
import { ISpace, IKeyInfo, IStoreV2, IBinding } from "../core/types";
import { keySettingsUrl } from "../core/hosts";
import { UIHelper } from "./ui";
import { fail } from "./fail";
import { jsonData, jsonSetData, isJsonMode } from "./jsonOutput";
import { slugify, findSpace, findIdentity, validateIdentityName } from "../core/identity";
import { loadConfig, persistConfig, saveStore, setIdentityKey } from "../infra/store";
import { writeRulesGitconfig } from "../infra/rules";
// Circular import: ./firstRun imports addSpace back from this file. Safe
// under CommonJS only because `firstRunFlow` is called exclusively inside
// listSpaces/switchSpace's async bodies below, never at module scope — see
// the matching note in src/commands/firstRun.ts. Keep any new use of
// `firstRunFlow` inside a function body.
import { firstRunFlow } from "./firstRun";

// A userName/email reaches writeActiveGitconfig (src/infra/git.ts), which
// hard-rejects an embedded \n/\r as a defense-in-depth last line — but the
// prompt layer should catch it first so the failure surfaces as a normal
// re-prompt instead of a mid-flow fail(). Kept in sync in spirit, not code,
// with writeActiveGitconfig's own guard.
function containsLineBreak(value: string): boolean {
  return /[\r\n]/.test(value);
}

function validateEmailValue(value: string): string | true {
  if (!value.trim()) return "Email is required!";
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(value)) return "Please enter a valid email address";
  return true;
}

// addSpace's userName rule (non-empty, >=2 chars, no line breaks) is
// stricter than modifySpace's (non-empty, no line breaks — no length
// floor); kept as two functions rather than unified to preserve each
// command's existing prompt behavior exactly.
function validateNewUserName(value: string): string | true {
  if (!value.trim()) return "User name is required!";
  if (value.length < 2) return "User name must be at least 2 characters long";
  if (containsLineBreak(value)) return "User name cannot contain line breaks";
  return true;
}

function validateEditUserName(value: string): string | true {
  if (!value.trim()) return "User name is required!";
  if (containsLineBreak(value)) return "User name cannot contain line breaks";
  return true;
}

/** Applied to a value supplied directly via flag (interactive prompts
 * already loop on `validate` themselves via @inquirer/prompts; a flag skips
 * that loop, so it gets exactly one validation pass here instead). Throws a
 * UsageError (exit 2) rather than fail()ing, matching every other
 * missing/invalid-non-interactive-input path in this module. */
function assertValid(value: string, validate: (v: string) => string | true, label: string): void {
  const result = validate(value);
  if (result !== true) throw new UsageError(`Invalid value for ${label}: ${result}`);
}

const KEY_TYPES = ['ed25519', 'rsa', 'none'] as const;
type KeyType = typeof KEY_TYPES[number];

function isKeyType(value: string): value is KeyType {
  return (KEY_TYPES as readonly string[]).includes(value);
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
 * Deliberately does NOT touch repo-local bindings (`dss link`) — those are
 * refreshed separately, independent of whether the identity is the
 * globally-active one (see modifySpace's own binding-refresh loop).
 */
export async function reapplyActiveIdentity(space: ISpace, store: IStoreV2): Promise<void> {
  if (!store.active || slugify(store.active) !== slugify(space.name)) return;

  await writeActiveGitconfig(space);
  await ensureGlobalInclude(activeGitconfigPath());
  if (space.sshKeyPath) {
    await setHostSSHKey(space.sshKeyPath, space.host ?? 'github.com');
  }
}

/**
 * Re-runs bindRepository for each of `matchingBindings` (registered `dss
 * link` entries for one identity), refreshing that repo's private binding
 * config (user/email/core.sshCommand) to match `space`'s CURRENT values.
 * Shared by modifySpace (rename/email/userName/key-path edits) and `dss key
 * rotate` (key-path changes) — the exact registry-driven refresh loop, so
 * both stay in sync rather than slowly drifting apart. A repo that no
 * longer exists (or otherwise fails to bind) is warned by name; its
 * registry entry is left in place rather than removed, since the failure
 * may be transient. Prints a one-line "Refreshed N binding(s); M need
 * attention." summary and returns the counts for callers (e.g. `dss key
 * rotate`'s JSON payload) that need them.
 */
export async function refreshRegisteredBindings(
  matchingBindings: IBinding[],
  space: ISpace
): Promise<{ refreshed: number; needsAttention: number }> {
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
  return { refreshed, needsAttention };
}

export interface NewIdentityOptions {
  name?: string;
  email?: string;
  user?: string;
  host?: string;
  /** 'ed25519' | 'rsa' generates a key of that type (skipping the "generate
   * a key?" confirm); 'none' skips key generation entirely. */
  key?: string;
  passphrase?: string;
}

export async function addSpace(options: NewIdentityOptions = {}) {
  UIHelper.printHeader("Create New Identity");
  UIHelper.info("Please provide the following information:");

  let name: string;
  if (options.name !== undefined) {
    assertValid(options.name, validateIdentityName, '--name');
    name = options.name;
  } else {
    name = await guardedInput({
      message: "Identity name:",
      validate: (value) => validateIdentityName(value),
      flagName: '--name',
    });
  }

  let email: string;
  if (options.email !== undefined) {
    assertValid(options.email, validateEmailValue, '--email');
    email = options.email.trim();
  } else {
    email = (
      await guardedInput({
        message: "Email address:",
        validate: validateEmailValue,
        flagName: '--email',
      })
    )?.trim();
  }

  let userName: string;
  if (options.user !== undefined) {
    assertValid(options.user, validateNewUserName, '--user');
    userName = options.user;
  } else {
    userName = await guardedInput({
      message: "User name:",
      validate: validateNewUserName,
      flagName: '--user',
    });
  }

  let host: string;
  if (options.host !== undefined) {
    assertValid(options.host, validateCustomHost, '--host');
    host = options.host;
  } else {
    host = await guardedPromptHost({ flagName: '--host' });
  }

  // Key generation: --key <ed25519|rsa|none> always wins (skips the confirm
  // in BOTH modes). Without it: `-y`/non-interactive default to generating
  // a key (matching the interactive default of that confirm), since a
  // missing --key isn't a "required value" a script must supply — it's an
  // ordinary confirm with a documented default.
  let shouldGenerateKey: boolean;
  let keyAlgorithm: 'ed25519' | 'rsa' = 'ed25519';
  if (options.key !== undefined) {
    if (!isKeyType(options.key)) {
      throw new UsageError(`Invalid value for --key: "${options.key}" (expected ed25519, rsa, or none)`);
    }
    shouldGenerateKey = options.key !== 'none';
    if (options.key !== 'none') keyAlgorithm = options.key;
  } else if (isNonInteractive() || assumeYes()) {
    shouldGenerateKey = true;
  } else {
    shouldGenerateKey = await safeConfirm({
      message: "Generate a new SSH key for this identity?",
      default: true,
    });
  }

  // --passphrase only means something when a key is actually being
  // generated — silently ignoring it when --key none is also given would
  // let a script believe it set a passphrase that was never applied
  // (review finding #7).
  if (!shouldGenerateKey && options.passphrase !== undefined) {
    throw new UsageError('--passphrase requires a key type other than none');
  }

  const passphrase = !shouldGenerateKey
    ? ""
    : options.passphrase ?? await guardedPassword({
        message: "Passphrase for the key (empty for none):",
        flagName: '--passphrase',
        nonInteractiveDefault: '',
      });

  const { store, config, originalBySpace } = await loadConfig();
  const slugifiedSpaceName = slugify(name);

  if (findSpace(config, slugifiedSpaceName)) {
    fail(`An identity with the name "${name}" already exists.`);
    UIHelper.info("Please choose a different name or use " + UIHelper.command("dss edit") + " to modify the existing identity.");
    return;
  }

  let sshKeyPath = "";
  let generatedKeyInfo: IKeyInfo | undefined;
  if (shouldGenerateKey) {
    UIHelper.printProgress("Generating SSH key");
    const keyDirectory = path.join(os.homedir(), ".dss", "spaces", slugifiedSpaceName);
    generatedKeyInfo = await generateKey({
      directory: keyDirectory,
      algorithm: keyAlgorithm,
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

      UIHelper.print(UIHelper.dim("\nPublic SSH Key:"));
      UIHelper.print(UIHelper.highlight(publicKey));
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

  // Optional/informational: the identity was already created successfully
  // above, so a script running non-interactively without -y shouldn't be
  // forced to answer (or blocked by) this nice-to-have follow-up — it
  // silently declines, same as `dss use <name>` would need to be run
  // separately regardless.
  const switchToNewSpace = await guardedConfirm({
    message: `Do you want to switch to the newly added identity "${slugifiedSpaceName}" now?`,
    default: true,
    optional: true,
  });

  if (switchToNewSpace) {
    UIHelper.info("Switching to new identity...");
    // switchSpace is `use`'s own handler and sets its own jsonData
    // (switched/previous) when reused here — jsonSetData below REPLACES
    // whatever it merged in, so `new`'s payload is exactly {created, key,
    // switched} regardless (review finding #3), with `switched` staying
    // the boolean this command's contract promises, not `use`'s
    // space-name string.
    await switchSpace(slugifiedSpaceName);
  } else {
    UIHelper.success(`Identity "${UIHelper.highlight(slugifiedSpaceName)}" added successfully!`);
    UIHelper.info("Use " + UIHelper.command(`dss use ${slugifiedSpaceName}`) + " to activate it.");
  }

  jsonSetData({
    created: { name: slugifiedSpaceName, email, userName, host },
    key: generatedKeyInfo
      ? { algorithm: generatedKeyInfo.algorithm, fingerprint: generatedKeyInfo.fingerprint ?? null }
      : null,
    switched: switchToNewSpace,
  });
}

export async function listSpaces() {
  const { config } = await loadConfig();

  jsonData({
    identities: config.spaces.map(space => ({
      name: space.name,
      email: space.email,
      userName: space.userName,
      host: space.host ?? 'github.com',
      active: space.name === config.activeSpace,
      hasKey: Boolean(space.sshKeyPath),
    })),
    active: config.activeSpace ?? null,
  });

  if (config.spaces.length === 0) {
    // firstRunFlow's own optional "create your first identity now?" confirm
    // resolves false without prompting in JSON mode (isNonInteractive() is
    // true), so this never opens the interactive addSpace() flow here.
    await firstRunFlow(config);
    return;
  }

  UIHelper.printHeader("Your Identities");
  UIHelper.printSpaceTable(config.spaces, config.activeSpace);
}

export async function switchSpace(
  spaceName?: string,
  options?: { dryRun?: boolean }
): Promise<void> {
  const { store, config, originalBySpace } = await loadConfig();

  // firstRunFlow only applies to the INTERACTIVE empty-store, no-name case
  // (review finding #3): a name was explicitly supplied (`dss use nope`)
  // must fail "not found" regardless of store size, rather than silently
  // detouring into the welcome flow and exiting 0; a non-interactive
  // invocation with no name has no identity to fall back to and no store to
  // prompt from, so it falls through to the guardedSelect below, which
  // throws its own UsageError (exit 2) naming the missing positional
  // instead of firstRunFlow's optional (silently-declining) confirm.
  if (!spaceName && config.spaces.length === 0 && !isNonInteractive()) {
    await firstRunFlow(config);
    return;
  }

  let selectedSpaceName = spaceName;

  if (!selectedSpaceName) {
    UIHelper.printHeader("Switch Identity");

    // Use enhanced selection with fuzzy search
    selectedSpaceName = await guardedSelect({
      message: "Choose an identity to switch to:",
      choices: config.spaces.map((space) => ({
        name: space.name === config.activeSpace ? UIHelper.activeSpace(space.name) : UIHelper.inactiveSpace(space.name),
        value: space.name,
        description: `${space.email} (${space.userName})`
      })),
      flagName: 'the identityName argument',
    }).catch((error) => {
      if (isPromptExitError(error)) return undefined;
      throw error;
    });
  }

  if (!selectedSpaceName) return;

  const space = findSpace(config, selectedSpaceName);
  if (!space) {
    fail(`Identity "${selectedSpaceName}" not found.`);
    UIHelper.info("Available identities:");
    config.spaces.forEach(s => {
      UIHelper.print(`  ${UIHelper.bullet()} ${UIHelper.highlight(s.name)} (${s.email})`);
    });
    return;
  }

  if (config.activeSpace === space.name) {
    UIHelper.warning(`Identity "${UIHelper.highlight(space.name)}" is already active.`);
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
    UIHelper.printInfoBox("Dry Run: Switch Identity Preview", previewLines);
    return;
  }

  try {
    UIHelper.printProgress("Switching to identity");

    // Set Git configuration (includeIf-first: write the DSS-managed
    // active.gitconfig and make sure the user's global config includes it,
    // rather than writing user.name/user.email directly).
    await writeActiveGitconfig(space);
    await ensureGlobalInclude(activeGitconfigPath());
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
        `Identity "${space.name}" has no SSH key — Git identity switched, SSH config unchanged. ` +
        `Use ${UIHelper.command('dss key rotate')} (regenerate SSH keys) to add one.`
      );
    }

    const previousActive = config.activeSpace ?? null;
    config.activeSpace = space.name;
    await persistConfig(store, config, originalBySpace);
    jsonData({ switched: space.name, previous: previousActive });

    UIHelper.clearProgress();
    UIHelper.printSuccessBox("Identity Activated", [
      `Switched to: ${space.name}`,
      `Git user: ${space.userName}`,
      `Email: ${space.email}`,
      hasKey ? `SSH key: activated` : `SSH key: none`
    ]);

    if (hasKey) {
      // Optional/informational: this runs AFTER the switch already
      // succeeded and persisted, so neither a closed prompt (Ctrl+C /
      // non-TTY, handled by guardedConfirm's underlying safeConfirm) nor
      // running non-interactively without -y (guardedConfirm's `optional`
      // exception) may surface as a command failure — a raw confirm()
      // throwing here would fall into the catch below and fail() the whole
      // command after the real work is already done.
      const confirmTest = await guardedConfirm({
        message: `Test SSH access to ${host} for this identity?`,
        default: false,
        optional: true,
      });

      if (confirmTest) {
        await testHostAccess(space.sshKeyPath, host);
      }
    }

    // The trailing "here's the full list" recap is a decorative convenience
    // for an interactive terminal — an agent reading `--json` output never
    // sees it, and listSpaces() has its own jsonData() merge (identities/
    // active) that would otherwise pollute `use`'s payload with foreign
    // keys (review finding #3). Skip the call entirely in JSON mode so
    // `use`'s data object is exactly {switched, previous}.
    if (!isJsonMode()) {
      UIHelper.print(""); // Add spacing
      await listSpaces();
    }
  } catch (error) {
    UIHelper.clearProgress();
    fail(`Failed to switch to identity "${selectedSpaceName}": ${(error as Error).message}`);
  }
}

export async function removeSpace(spaceName?: string, options?: { dryRun?: boolean }) {
  const { store, config, originalBySpace } = await loadConfig();

  if (config.spaces.length === 0) {
    UIHelper.warning("No identities yet.");
    UIHelper.info("Use " + UIHelper.command("dss new") + " to create your first identity.");
    return;
  }

  UIHelper.printHeader("Remove Identity");
  if (!options?.dryRun) {
    UIHelper.warning("This action cannot be undone!");
  }

  let selectedSpaceName = spaceName;
  if (!selectedSpaceName) {
    selectedSpaceName = await guardedSelect({
      message: "Select an identity to remove:",
      choices: config.spaces.map((space) => ({
        name: space.name === config.activeSpace ? UIHelper.activeSpace(space.name) + " (active)" : space.name,
        value: space.name,
        description: `${space.email} (${space.userName})`
      })),
      flagName: 'the identityName argument',
    });
  }

  const spaceToRemove = findSpace(config, selectedSpaceName);
  if (!spaceToRemove) {
    fail(`Identity "${selectedSpaceName}" not found.`);
    return;
  }

  if (spaceToRemove.name === config.activeSpace) {
    fail(`Cannot remove the active identity '${UIHelper.highlight(spaceToRemove.name)}'.`);
    UIHelper.info("Please switch to another identity first using " + UIHelper.command("dss use") + ".");
    return;
  }

  // Show details of what will be removed
  UIHelper.print(UIHelper.dim("\nIdentity to be removed:"));
  UIHelper.print(`  Name: ${UIHelper.highlight(spaceToRemove.name)}`);
  UIHelper.print(`  Email: ${spaceToRemove.email}`);
  UIHelper.print(`  User: ${spaceToRemove.userName}`);
  UIHelper.print(`  SSH Key: ${UIHelper.filename(spaceToRemove.sshKeyPath)}`);

  // Check for dry-run mode
  if (options?.dryRun) {
    const hasKey = Boolean(spaceToRemove.sshKeyPath);
    UIHelper.printInfoBox("Dry Run: Remove Identity Preview", [
      `Would remove identity: ${spaceToRemove.name}`,
      `Would remove from configuration`,
      hasKey ? `Would remove SSH key from agent` : `No SSH key configured — agent removal skipped`,
      `SSH key files would remain on disk`,
      'Use without --dry-run to actually remove'
    ]);
    return;
  }

  // Required-affirm: destructive, so non-interactive mode without -y errors
  // (exit 2) rather than silently declining or silently proceeding.
  const confirmRemoval = await guardedConfirm({
    message: `Are you absolutely sure you want to remove '${spaceToRemove.name}'?`,
    default: false,
  });

  if (!confirmRemoval) {
    UIHelper.info("Removal cancelled.");
    return;
  }

  try {
    UIHelper.printProgress("Removing identity");

    // Remove SSH key from agent
    if (spaceToRemove.sshKeyPath) {
      await removeSSHKeyFromAgent(spaceToRemove.sshKeyPath);
    }

    // Remove from config
    config.spaces = config.spaces.filter((space) => space.name !== spaceToRemove.name);
    await persistConfig(store, config, originalBySpace);
    jsonData({ removed: spaceToRemove.name });

    UIHelper.clearProgress();
    UIHelper.success(`Identity '${UIHelper.highlight(spaceToRemove.name)}' has been removed successfully.`);

    // Registered repo-local bindings aren't removed here — only `dss unlink`
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
        UIHelper.print(`  ${UIHelper.bullet()} ${binding.path}`);
      });
      UIHelper.info(`Run ${UIHelper.command('dss unlink')} in each repository to clear the binding.`);
    }

    // Show remaining identities
    if (config.spaces.length > 0) {
      UIHelper.print(UIHelper.dim("\nRemaining identities:"));
      config.spaces.forEach(space => {
        UIHelper.print(`  ${UIHelper.bullet()} ${UIHelper.highlight(space.name)} (${space.email})`);
      });
    } else {
      UIHelper.info("No identities remaining. Use " + UIHelper.command("dss new") + " to create a new one.");
    }
  } catch (error) {
    UIHelper.clearProgress();
    fail(`Failed to remove identity: ${(error as Error).message}`);
  }
}

export interface EditIdentityOptions {
  name?: string;
  email?: string;
  user?: string;
  host?: string;
}

export async function modifySpace(spaceName?: string, options: EditIdentityOptions = {}) {
  const { store, config, originalBySpace } = await loadConfig();

  if (config.spaces.length === 0) {
    UIHelper.warning("No identities yet.");
    UIHelper.info("Use " + UIHelper.command("dss new") + " to create your first identity.");
    return;
  }

  const selectedSpace = spaceName ?? await guardedSelect({
    message: "Which identity would you like to modify?",
    choices: config.spaces.map((space) => ({
      name: space.name,
      value: space.name,
    })),
    flagName: 'the identityName argument',
  });

  const space = findSpace(config, selectedSpace);
  if (!space) {
    fail(`Identity "${selectedSpace}" not found.`);
    return;
  }

  const wasActive = space.name === config.activeSpace;
  const originalName = space.name;
  const originalEmail = space.email;
  const originalUserName = space.userName;
  const originalHost = space.host ?? 'github.com';
  const originalSshKeyPath = space.sshKeyPath;

  // A name that's cosmetically different but slugifies the same (e.g.
  // retyping the current name, or a legacy raw name's normalized slug) is a
  // no-op rename — always allowed, even for a pre-existing name that
  // predates this validator. Only a genuine new name is checked.
  const validateEditName = (value: string): string | true =>
    slugify(value) === slugify(space.name) ? true : validateIdentityName(value);

  // Every field below keeps its CURRENT value in non-interactive mode when
  // no flag is given (nonInteractiveDefault) rather than erroring — an
  // edit's fields are all individually optional (each prompt is itself
  // "leave blank to skip"), unlike `dss new`'s required fields.
  let newSpaceName: string;
  if (options.name !== undefined) {
    assertValid(options.name, validateEditName, '--name');
    newSpaceName = options.name;
  } else {
    newSpaceName = await guardedInput({
      message: `New name for "${space.name}" (leave blank to skip):`,
      default: space.name,
      validate: validateEditName,
      flagName: '--name',
      nonInteractiveDefault: space.name,
    });
  }

  let email: string;
  if (options.email !== undefined) {
    assertValid(options.email, validateEmailValue, '--email');
    email = options.email;
  } else {
    email = await guardedInput({
      message: "New email (leave blank to skip):",
      default: space.email,
      validate: validateEmailValue,
      flagName: '--email',
      nonInteractiveDefault: space.email,
    });
  }

  let userName: string;
  if (options.user !== undefined) {
    assertValid(options.user, validateEditUserName, '--user');
    userName = options.user;
  } else {
    userName = await guardedInput({
      message: "New user name (leave blank to skip):",
      default: space.userName,
      validate: validateEditUserName,
      flagName: '--user',
      nonInteractiveDefault: space.userName,
    });
  }

  let host: string;
  if (options.host !== undefined) {
    assertValid(options.host, validateCustomHost, '--host');
    host = options.host;
  } else {
    host = await guardedPromptHost({
      currentHost: originalHost,
      flagName: '--host',
      nonInteractiveDefault: originalHost,
    });
  }

  let isUpdateMade = false;
  let keyDirMoved = false;
  const changes: Record<string, string> = {};
  if (slugify(newSpaceName) !== slugify(space.name)) {
    const newSlug = slugify(newSpaceName);
    const isDuplicate = config.spaces.some(
      (s) => s !== space && slugify(s.name) === newSlug
    );
    if (isDuplicate) {
      fail(`Another identity with the name "${newSpaceName}" already exists.`);
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
    changes.name = newSlug;
    isUpdateMade = true;
  }
  if (email !== originalEmail) {
    space.email = email;
    changes.email = email;
    isUpdateMade = true;
  }
  if (userName !== originalUserName) {
    space.userName = userName;
    changes.userName = userName;
    isUpdateMade = true;
  }
  if (host !== originalHost) {
    space.host = host;
    changes.host = host;
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
  // Directory rules referencing this identity — same slug-aware match as
  // matchingBindings above, and the same rename-condition trigger
  // (bindingRefreshNeeded) for regenerating the ruled identity's own
  // gitconfig file: a rename/email/userName/key-path edit must reach
  // ~/.dss/identities/<slug>.gitconfig the same way it reaches a repo-local
  // binding's private config, or the rule silently keeps applying stale
  // values.
  const matchingRules = store.rules.filter(
    (rule) => slugify(rule.identity) === slugify(originalName)
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

  if (matchingRules.length > 0 && renamed) {
    matchingRules.forEach((rule) => {
      rule.identity = space.name;
    });
  }

  // Persist before re-applying global git config / refreshing bindings so
  // disk (config + any moved key directory + renamed binding entries) stays
  // consistent even if either of those steps below fails.
  await persistConfig(store, config, originalBySpace);

  if (matchingBindings.length > 0) {
    if (bindingRefreshNeeded) {
      await refreshRegisteredBindings(matchingBindings, space);
    }
  } else if (keyDirMoved) {
    UIHelper.warning(
      `Repositories bound to this identity via ${UIHelper.command('dss link')} may still reference the old key path — ` +
      `re-bind them with ${UIHelper.command(`dss link ${space.name}`)}.`
    );
  }

  // Same trigger as the binding refresh above: an identity with existing
  // directory rules gets its ~/.dss/identities/<slug>.gitconfig rewritten
  // whenever a rename/email/userName/key-path edit touches it. A rename
  // additionally rewrites rules.gitconfig itself (matchingRules' entries
  // above already point at the NEW slug, so the compiled file must
  // reference identities/<new-slug>.gitconfig, not the old one).
  if (matchingRules.length > 0) {
    if (renamed) {
      try {
        await writeRulesGitconfig(store.rules);
      } catch (error) {
        UIHelper.warning(`Could not refresh the rules file: ${(error as Error).message}`);
      }
    }
    if (bindingRefreshNeeded) {
      const refreshedIdentity = findIdentity(store, space.name);
      if (refreshedIdentity) {
        try {
          await writeIdentityGitconfig(refreshedIdentity);
        } catch (error) {
          UIHelper.warning(`Could not refresh the rule gitconfig for "${space.name}": ${(error as Error).message}`);
        }
      }
    }
  }

  // Unified with bindingRefreshNeeded (rename, email, userName, or key-path
  // change) rather than a separate email/userName-only check: active.gitconfig
  // carries the key's sshCommand too now, so a rename-only or key-path-only
  // edit of the ACTIVE identity must also re-apply it — otherwise it's left
  // pointing at a key path that may no longer exist (that file is globally
  // included and unconditional, so a stale sshCommand breaks git SSH for
  // every remote on the machine until the next `dss use`). Delegates to
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
    UIHelper.success(`Identity "${UIHelper.highlight(space.name)}" updated successfully.`);
  } else {
    UIHelper.info("No changes were made to the identity.");
  }

  jsonData({ updated: space.name, changes });
}

