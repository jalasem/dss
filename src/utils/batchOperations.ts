import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { select, confirm, checkbox } from '@inquirer/prompts';
import { IConfig, ISpace } from './types';
import { UIHelper } from './ui';
import { switchSpace } from './SpaceManager';

const configPath = path.join(os.homedir(), '.dss', 'spaces', 'config.json');

export async function batchSwitchSpaces() {
  const config: IConfig = await fs.readJson(configPath);
  
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
      UIHelper.error(`Failed to switch to ${spaceName}: ${(error as Error).message}`);
      
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
  const config: IConfig = await fs.readJson(configPath);
  
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
    UIHelper.error(`Import file not found: ${importPath}`);
    UIHelper.info('Please ensure the export file exists in your home directory.');
    return;
  }

  try {
    const importData = await fs.readJson(importPath);
    
    if (!importData.spaces || !Array.isArray(importData.spaces)) {
      UIHelper.error('Invalid import file format.');
      return;
    }

    UIHelper.info(`Found ${importData.spaces.length} spaces in import file.`);
    
    const config: IConfig = await fs.readJson(configPath).catch(() => ({ spaces: [] }));
    
    const spacesToImport = importData.spaces.filter((importSpace: any) => {
      const exists = config.spaces.some(existing => existing.name === importSpace.name);
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
      name: importSpace.name,
      email: importSpace.email,
      userName: importSpace.userName,
      sshKeyPath: '' // Will need to be set up manually
    }));

    config.spaces.push(...newSpaces);
    await fs.writeJson(configPath, config);

    UIHelper.printSuccessBox('Import Completed', [
      `✓ ${spacesToImport.length} spaces imported`,
      '',
      'Note: SSH keys need to be set up manually',
      'Use `dss edit <space>` to configure SSH keys'
    ]);

  } catch (error) {
    UIHelper.error(`Failed to import configuration: ${(error as Error).message}`);
  }
}

export async function bulkUpdateSpaces() {
  const config: IConfig = await fs.readJson(configPath);
  
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

  // Implementation would depend on the update type
  UIHelper.info(`Bulk update feature for '${updateType}' coming soon!`);
  UIHelper.info(`Selected ${selectedSpaces.length} spaces for update.`);
}