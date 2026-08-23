import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { confirm, checkbox } from '@inquirer/prompts';
import { ISpace } from '../core/types';
import { UIHelper } from './ui';
import { fail } from './fail';
import { slugify, findSpace, validateIdentityName } from '../core/identity';
import { loadConfig, persistConfig } from '../infra/store';

function hasLineBreak(value: unknown): boolean {
  return typeof value === 'string' && /[\r\n]/.test(value);
}

/** The default export/import path, preserved from the pre-`config` command
 * behavior: `~/dss-export.json`. A caller-supplied path overrides it. */
function defaultExportPath(): string {
  return path.join(os.homedir(), 'dss-export.json');
}

export async function exportSpaceConfiguration(exportPath?: string) {
  const { config } = await loadConfig();

  if (config.spaces.length === 0) {
    UIHelper.warning('No identities to export.');
    return;
  }

  UIHelper.printHeader('Export Identity Configuration');

  const selectedSpaces = await checkbox({
    message: 'Select identities to export:',
    choices: config.spaces.map(space => ({
      name: space.name,
      value: space.name,
      description: `${space.email} (${space.userName})`
    }))
  });

  if (selectedSpaces.length === 0) {
    UIHelper.info('No identities selected for export.');
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

  const resolvedExportPath = exportPath ?? defaultExportPath();
  await fs.writeJson(resolvedExportPath, exportData, { spaces: 2 });

  UIHelper.printSuccessBox('Configuration Exported', [
    `${selectedSpaces.length} identities exported`,
    `Saved to: ${resolvedExportPath}`,
    'Note: SSH keys not included for security'
  ]);
}

export async function importSpaceConfiguration(importPathArg?: string) {
  UIHelper.printHeader('Import Identity Configuration');

  const importPath = importPathArg ?? defaultExportPath();

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

    UIHelper.info(`Found ${importData.spaces.length} identities in import file.`);

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
        UIHelper.warning(`Identity '${importSpace.name}' contains a line break in its name/email/userName/host - skipping.`);
        return false;
      }

      // The imported name becomes an fs path segment (key directory) once a
      // key is generated for it — reject anything outside addSpace's own
      // charset rule (e.g. "../../../tmp/x") rather than only slugifying it.
      const nameValidation = validateIdentityName(importSpace.name);
      if (nameValidation !== true) {
        UIHelper.warning(`Identity '${importSpace.name}' has an invalid name (${nameValidation}) - skipping.`);
        return false;
      }

      const exists = Boolean(findSpace(config, importSpace.name));
      if (exists) {
        UIHelper.warning(`Identity '${importSpace.name}' already exists - skipping.`);
      }
      return !exists;
    });

    if (spacesToImport.length === 0) {
      UIHelper.info('No new identities to import.');
      return;
    }

    const confirmImport = await confirm({
      message: `Import ${spacesToImport.length} new identities?`,
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
      `${spacesToImport.length} identities imported`,
      'Note: SSH keys need to be set up manually',
      'Use `dss edit <identity>` to configure SSH keys'
    ]);

  } catch (error) {
    fail(`Failed to import configuration: ${(error as Error).message}`);
  }
}
