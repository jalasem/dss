import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { select, confirm, checkbox, input } from '@inquirer/prompts';
import { ISpace, IKeyInfo } from '../core/types';
import { UIHelper } from './ui';
import { switchSpace, reapplyActiveIdentity } from './spaces';
import { generateKey } from '../infra/keys';
import { fail } from './fail';
import { slugify, findSpace, validateIdentityName } from '../core/identity';
import { loadConfig, persistConfig, saveStore, setIdentityKey } from '../infra/store';

function hasLineBreak(value: unknown): boolean {
  return typeof value === 'string' && /[\r\n]/.test(value);
}

export async function batchSwitchSpaces() {
  const { config } = await loadConfig();

  if (config.spaces.length === 0) {
    UIHelper.warning('No spaces available for batch operations.');
    return;
  }

  UIHelper.printHeader('Batch Switch Spaces');
  UIHelper.info('Select multiple spaces to switch between them quickly.');

  const selectedSpaces = await checkbox({
    message: 'Select spaces to switch between:',
    choices: config.spaces.map(space => ({
      name: space.name === config.activeSpace ? UIHelper.activeSpace(space.name) : space.name,
      value: space.name,
      description: `${space.email} (${space.userName})`
    }))
  });

  if (selectedSpaces.length === 0) {
    UIHelper.info('No spaces selected.');
    return;
  }

  UIHelper.info(`Selected ${selectedSpaces.length} spaces for batch switching.`);

  for (const spaceName of selectedSpaces) {
    try {
      UIHelper.info(`Switching to: ${UIHelper.highlight(spaceName)}`);
      await switchSpace(spaceName);

      const continueNext = await confirm({
        message: 'Continue to next space?',
        default: true
      });

      if (!continueNext) break;
    } catch (error) {
      fail(`Failed to switch to ${spaceName}: ${(error as Error).message}`);

      const continueOnError = await confirm({
        message: 'Continue with remaining spaces?',
        default: true
      });

      if (!continueOnError) break;
    }
  }

  UIHelper.success('Batch operation completed!');
}

export async function exportSpaceConfiguration() {
  const { config } = await loadConfig();

  if (config.spaces.length === 0) {
    UIHelper.warning('No spaces to export.');
    return;
  }

  UIHelper.printHeader('Export Space Configuration');

  const selectedSpaces = await checkbox({
    message: 'Select spaces to export:',
    choices: config.spaces.map(space => ({
      name: space.name,
      value: space.name,
      description: `${space.email} (${space.userName})`
    }))
  });

  if (selectedSpaces.length === 0) {
    UIHelper.info('No spaces selected for export.');
    return;
  }

  const exportData = {
    version: '1.0.0',
    exportDate: new Date().toISOString(),
    spaces: config.spaces.filter(space => selectedSpaces.includes(space.name))
      .map(space => ({
        name: space.name,
        email: space.email,
        userName: space.userName,
        host: space.host ?? 'github.com',
        // Don't export SSH key paths for security
        hasSSHKey: !!space.sshKeyPath
      }))
  };

  const exportPath = path.join(os.homedir(), 'dss-export.json');
  await fs.writeJson(exportPath, exportData, { spaces: 2 });

  UIHelper.printSuccessBox('Configuration Exported', [
    `✓ ${selectedSpaces.length} spaces exported`,
    `✓ Saved to: ${exportPath}`,
    '',
    'Note: SSH keys not included for security'
  ]);
}

export async function importSpaceConfiguration() {
  UIHelper.printHeader('Import Space Configuration');

  const importPath = path.join(os.homedir(), 'dss-export.json');

  if (!await fs.pathExists(importPath)) {
    fail(`Import file not found: ${importPath}`);
    UIHelper.info('Please ensure the export file exists in your home directory.');
    return;
  }

  try {
    const importData = await fs.readJson(importPath);

    if (!importData.spaces || !Array.isArray(importData.spaces)) {
      fail('Invalid import file format.');
      return;
    }

    UIHelper.info(`Found ${importData.spaces.length} spaces in import file.`);

    const { store, config, originalBySpace } = await loadConfig();

    const spacesToImport = importData.spaces.filter((importSpace: any) => {
      // Imported name/email/userName/host/sshKeyPath are unvalidated JSON —
      // a line break in any of them would eventually reach
      // writeActiveGitconfig or setHostSSHKey, both globally-included/
      // applied files, where it can corrupt or inject config lines (host in
      // particular reaches the ssh-config writer, an RCE vector via
      // ProxyCommand). Reject here rather than relying solely on those
      // later hard gates.
      if (
        hasLineBreak(importSpace.name)
        || hasLineBreak(importSpace.email)
        || hasLineBreak(importSpace.userName)
        || hasLineBreak(importSpace.host)
        || hasLineBreak(importSpace.sshKeyPath)
      ) {
        UIHelper.warning(`Space '${importSpace.name}' contains a line break in its name/email/userName/host - skipping.`);
        return false;
      }

      // The imported name becomes an fs path segment (key directory) once a
      // key is generated for it — reject anything outside addSpace's own
      // charset rule (e.g. "../../../tmp/x") rather than only slugifying it.
      const nameValidation = validateIdentityName(importSpace.name);
      if (nameValidation !== true) {
        UIHelper.warning(`Space '${importSpace.name}' has an invalid name (${nameValidation}) - skipping.`);
        return false;
      }

      const exists = Boolean(findSpace(config, importSpace.name));
      if (exists) {
        UIHelper.warning(`Space '${importSpace.name}' already exists - skipping.`);
      }
      return !exists;
    });

    if (spacesToImport.length === 0) {
      UIHelper.info('No new spaces to import.');
      return;
    }

    const confirmImport = await confirm({
      message: `Import ${spacesToImport.length} new spaces?`,
      default: true
    });

    if (!confirmImport) {
      UIHelper.info('Import cancelled.');
      return;
    }

    // Convert import format to internal format
    const newSpaces: ISpace[] = spacesToImport.map((importSpace: any) => ({
      name: slugify(importSpace.name),
      email: importSpace.email,
      userName: importSpace.userName,
      host: importSpace.host ?? 'github.com',
      sshKeyPath: '' // Will need to be set up manually
    }));

    config.spaces.push(...newSpaces);
    await persistConfig(store, config, originalBySpace);

    UIHelper.printSuccessBox('Import Completed', [
      `✓ ${spacesToImport.length} spaces imported`,
      '',
      'Note: SSH keys need to be set up manually',
      'Use `dss edit <space>` to configure SSH keys'
    ]);

  } catch (error) {
    fail(`Failed to import configuration: ${(error as Error).message}`);
  }
}

export async function bulkUpdateSpaces(options: { dryRun?: boolean } = {}): Promise<void> {
  const dryRun = Boolean(options.dryRun);
  const { store, config, originalBySpace } = await loadConfig();

  if (config.spaces.length === 0) {
    UIHelper.warning('No spaces available for bulk update.');
    return;
  }

  UIHelper.printHeader('Bulk Update Spaces');

  const updateType = await select({
    message: 'What would you like to update?',
    choices: [
      { name: 'Email domain', value: 'email-domain' },
      { name: 'User name prefix/suffix', value: 'username-pattern' },
      { name: 'Regenerate SSH keys', value: 'regenerate-keys' }
    ]
  });

  const selectedSpaces = await checkbox({
    message: 'Select spaces to update:',
    choices: config.spaces.map(space => ({
      name: space.name,
      value: space.name,
      description: `${space.email} (${space.userName})`
    }))
  });

  if (selectedSpaces.length === 0) {
    UIHelper.info('No spaces selected.');
    return;
  }

  UIHelper.info(`Selected ${selectedSpaces.length} spaces for update.`);

  let updatedCount = 0;
  let regenerateKeysMetadata: Map<string, IKeyInfo> | undefined;
  const previewLines: string[] = [];

  try {
    switch (updateType) {
      case 'email-domain': {
        const oldDomain = await input({
          message: 'Enter the old domain to replace (e.g., oldcompany.com):',
          validate: (input) => input.trim().length > 0 || 'Domain is required'
        });

        const newDomain = await input({
          message: 'Enter the new domain (e.g., newcompany.com):',
          validate: (input) => input.trim().length > 0 || 'Domain is required'
        });

        if (!dryRun) UIHelper.printProgress(`Updating email domains from ${oldDomain} to ${newDomain}`);

        for (const spaceName of selectedSpaces) {
          const space = config.spaces.find(s => s.name === spaceName);
          if (space && space.email.includes(oldDomain)) {
            const newEmail = space.email.replace(oldDomain, newDomain);
            if (dryRun) {
              previewLines.push(`✓ ${space.name}: email ${space.email} → ${newEmail}`);
            } else {
              space.email = newEmail;
            }
            updatedCount++;
          }
        }
        break;
      }

      case 'username-pattern': {
        const operation = await select({
          message: 'What would you like to do with usernames?',
          choices: [
            { name: 'Add prefix', value: 'add-prefix' },
            { name: 'Add suffix', value: 'add-suffix' },
            { name: 'Replace text', value: 'replace' }
          ]
        });

        if (operation === 'add-prefix') {
          const prefix = await input({
            message: 'Enter prefix to add:',
            validate: (input) => input.trim().length > 0 || 'Prefix is required'
          });

          if (!dryRun) UIHelper.printProgress(`Adding prefix "${prefix}" to usernames`);

          for (const spaceName of selectedSpaces) {
            const space = config.spaces.find(s => s.name === spaceName);
            if (space && !space.userName.startsWith(prefix)) {
              const newUserName = prefix + space.userName;
              if (dryRun) {
                previewLines.push(`✓ ${space.name}: userName ${space.userName} → ${newUserName}`);
              } else {
                space.userName = newUserName;
              }
              updatedCount++;
            }
          }
        } else if (operation === 'add-suffix') {
          const suffix = await input({
            message: 'Enter suffix to add:',
            validate: (input) => input.trim().length > 0 || 'Suffix is required'
          });

          if (!dryRun) UIHelper.printProgress(`Adding suffix "${suffix}" to usernames`);

          for (const spaceName of selectedSpaces) {
            const space = config.spaces.find(s => s.name === spaceName);
            if (space && !space.userName.endsWith(suffix)) {
              const newUserName = space.userName + suffix;
              if (dryRun) {
                previewLines.push(`✓ ${space.name}: userName ${space.userName} → ${newUserName}`);
              } else {
                space.userName = newUserName;
              }
              updatedCount++;
            }
          }
        } else if (operation === 'replace') {
          const oldText = await input({
            message: 'Enter text to replace:',
            validate: (input) => input.trim().length > 0 || 'Text is required'
          });

          const newText = await input({
            message: 'Enter replacement text:',
            validate: (input) => input.trim().length > 0 || 'Replacement text is required'
          });

          if (!dryRun) UIHelper.printProgress(`Replacing "${oldText}" with "${newText}" in usernames`);

          for (const spaceName of selectedSpaces) {
            const space = config.spaces.find(s => s.name === spaceName);
            if (space && space.userName.includes(oldText)) {
              const newUserName = space.userName.replace(new RegExp(oldText, 'g'), newText);
              if (dryRun) {
                previewLines.push(`✓ ${space.name}: userName ${space.userName} → ${newUserName}`);
              } else {
                space.userName = newUserName;
              }
              updatedCount++;
            }
          }
        }
        break;
      }

      case 'regenerate-keys': {
        if (!dryRun) {
          const confirmRegenerate = await confirm({
            message: 'Are you sure you want to regenerate SSH keys? This will replace existing keys.',
            default: false
          });

          if (!confirmRegenerate) {
            UIHelper.info('SSH key regeneration cancelled.');
            return;
          }
        }

        if (dryRun) {
          for (const spaceName of selectedSpaces) {
            const space = config.spaces.find(s => s.name === spaceName);
            if (space) {
              previewLines.push(`✓ ${space.name}: SSH key would be regenerated`);
              updatedCount++;
            }
          }
          break;
        }

        UIHelper.printProgress('Regenerating SSH keys');

        const generatedKeyInfoByName = new Map<string, IKeyInfo>();

        for (const spaceName of selectedSpaces) {
          const space = config.spaces.find(s => s.name === spaceName);
          if (space) {
            try {
              UIHelper.updateProgress(`Regenerating SSH key for ${space.name}`);
              const originalIdentity = originalBySpace.get(space);
              const algorithm = originalIdentity?.key?.algorithm === 'rsa' ? 'rsa' : 'ed25519';
              const directory = space.sshKeyPath
                ? path.dirname(space.sshKeyPath)
                : path.join(os.homedir(), '.dss', 'spaces', space.name);
              const keyInfo = await generateKey({ directory, algorithm, comment: space.email });
              space.sshKeyPath = keyInfo.path;
              generatedKeyInfoByName.set(space.name, keyInfo);
              updatedCount++;
            } catch (error) {
              fail(`Failed to regenerate SSH key for ${space.name}: ${(error as Error).message}`);
            }
          }
        }

        regenerateKeysMetadata = generatedKeyInfoByName;
        break;
      }
    }

    UIHelper.clearProgress();

    if (dryRun) {
      if (updatedCount > 0) {
        UIHelper.printInfoBox('Dry Run: Bulk Update Preview', [
          ...previewLines,
          '',
          'Use without --dry-run to apply changes'
        ]);
      } else {
        UIHelper.info('No spaces would be updated.');
      }
      return;
    }

    if (updatedCount > 0) {
      await persistConfig(store, config, originalBySpace);

      // persistConfig writes identities through the ISpace view, which
      // can't carry a key's fingerprint/createdAt — set full metadata for
      // any regenerated keys directly.
      if (regenerateKeysMetadata && regenerateKeysMetadata.size > 0) {
        for (const [identityName, keyInfo] of regenerateKeysMetadata) {
          setIdentityKey(store, identityName, keyInfo);
        }
        await saveStore(store);
      }

      // A bulk edit can touch the ACTIVE identity's email/username/key —
      // left unrefreshed, active.gitconfig/ssh-config would keep the old
      // values while `dss list`/`dss inspect` already show the new ones
      // (e.g. commits still authored with the stale email).
      if (store.active && selectedSpaces.includes(store.active)) {
        const activeSpace = config.spaces.find(s => s.name === store.active);
        if (activeSpace) {
          try {
            await reapplyActiveIdentity(activeSpace, store);
          } catch (error) {
            UIHelper.warning(
              `Bulk update saved, but re-applying the active identity's global git/SSH config failed: ${(error as Error).message}`
            );
          }
        }
      }

      UIHelper.printSuccessBox('Bulk Update Complete', [
        `✓ ${updatedCount} spaces updated successfully`,
        `✓ Operation: ${updateType}`,
        '',
        'Use `dss list` to view updated spaces'
      ]);
    } else {
      UIHelper.info('No spaces were updated.');
    }

  } catch (error) {
    UIHelper.clearProgress();
    fail(`Bulk update failed: ${(error as Error).message}`);
  }
}
