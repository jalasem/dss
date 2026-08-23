import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { generateKey } from '../infra/keys';
import { addToAgent } from '../infra/ssh';
import { copyToClipboard } from '../infra/clipboard';
import { loadStore, saveStore, setIdentityKey } from '../infra/store';
import { findIdentity } from '../core/identity';
import { IIdentity, IStoreV2 } from '../core/types';
import { UIHelper } from './ui';
import { fail } from './fail';
import { safeConfirm } from './prompts';

// Task 4 makes this host-aware; hardcoded to GitHub for now.
const GITHUB_KEY_SETTINGS_URL = 'https://github.com/settings/keys';

async function resolveTargetIdentity(store: IStoreV2, identityName?: string): Promise<IIdentity | undefined> {
  if (identityName) {
    const identity = findIdentity(store, identityName);
    if (!identity) {
      fail(`Identity "${identityName}" not found.`);
      return undefined;
    }
    return identity;
  }

  if (!store.active) {
    fail('No active identity. Specify an identity name or switch to one first.');
    return undefined;
  }

  const identity = findIdentity(store, store.active);
  if (!identity) {
    fail(`Active identity "${store.active}" not found.`);
    return undefined;
  }
  return identity;
}

function failKeyless(identity: IIdentity): void {
  fail(`Identity "${identity.name}" has no SSH key.`);
  UIHelper.info(`Use ${UIHelper.command(`dss key rotate ${identity.name}`)} to create one.`);
}

export async function showKey(identityName?: string): Promise<void> {
  const store = await loadStore();
  const identity = await resolveTargetIdentity(store, identityName);
  if (!identity) return;

  if (!identity.key) {
    failKeyless(identity);
    return;
  }

  const publicKeyPath = `${identity.key.path}.pub`;
  let publicKey: string;
  try {
    publicKey = await fs.readFile(publicKeyPath, 'utf8');
  } catch (error) {
    fail(`Failed to read public key at ${publicKeyPath}: ${(error as Error).message}`);
    return;
  }

  UIHelper.printHeader(`SSH Key: ${identity.name}`);
  UIHelper.printStatus('Algorithm', identity.key.algorithm, 'info');
  UIHelper.printStatus('Fingerprint', identity.key.fingerprint ?? 'unknown', 'info');
  UIHelper.printStatus('Created', identity.key.createdAt ?? 'unknown', 'info');
  console.log(UIHelper.dim('\nPublic SSH Key:'));
  console.log(UIHelper.highlight(publicKey.trim()));
  console.log('');
  UIHelper.info(`GitHub SSH Keys: ${GITHUB_KEY_SETTINGS_URL}`);
}

export async function copyKey(identityName?: string): Promise<void> {
  const store = await loadStore();
  const identity = await resolveTargetIdentity(store, identityName);
  if (!identity) return;

  if (!identity.key) {
    failKeyless(identity);
    return;
  }

  const publicKeyPath = `${identity.key.path}.pub`;
  try {
    const publicKey = await fs.readFile(publicKeyPath, 'utf8');
    await copyToClipboard(publicKey);
    UIHelper.success(`Public key for "${identity.name}" copied to clipboard.`);
  } catch (error) {
    fail(`Failed to copy public key: ${(error as Error).message}`);
  }
}

export async function rotateKey(identityName?: string): Promise<void> {
  const store = await loadStore();
  const identity = await resolveTargetIdentity(store, identityName);
  if (!identity) return;

  const hasExistingKey = Boolean(identity.key);
  const confirmed = await safeConfirm({
    message: hasExistingKey
      ? `Rotate the SSH key for "${identity.name}"? The old key will stop working for ${identity.host} until the new public key is uploaded.`
      : `Generate a new SSH key for "${identity.name}"?`,
    default: false,
  });

  if (!confirmed) {
    UIHelper.info('Key rotation cancelled.');
    return;
  }

  const algorithm = identity.key?.algorithm === 'rsa' ? 'rsa' : 'ed25519';
  const directory = identity.key?.path
    ? path.dirname(identity.key.path)
    : path.join(os.homedir(), '.dss', 'spaces', identity.name);

  UIHelper.printProgress('Generating new SSH key');
  let keyInfo;
  try {
    keyInfo = await generateKey({ directory, algorithm, comment: identity.email });
  } catch (error) {
    UIHelper.clearProgress();
    fail(`Failed to generate SSH key: ${(error as Error).message}`);
    return;
  }
  UIHelper.clearProgress();

  setIdentityKey(store, identity.name, keyInfo);
  await saveStore(store);

  try {
    await addToAgent(keyInfo.path);
  } catch (error) {
    UIHelper.warning(`Key generated but could not be added to the ssh-agent: ${(error as Error).message}`);
  }

  let publicKey = '';
  try {
    publicKey = await fs.readFile(`${keyInfo.path}.pub`, 'utf8');
    await copyToClipboard(publicKey);
  } catch (error) {
    UIHelper.warning(`Could not read/copy the new public key: ${(error as Error).message}`);
  }

  UIHelper.printSuccessBox('SSH Key Rotated', [
    `✓ Algorithm: ${keyInfo.algorithm}`,
    `✓ Fingerprint: ${keyInfo.fingerprint ?? 'unknown'}`,
    publicKey ? '✓ Public key copied to clipboard' : '⚠ Public key could not be copied to clipboard',
    '',
    `GitHub SSH Keys: ${GITHUB_KEY_SETTINGS_URL}`
  ]);

  if (publicKey) {
    console.log(UIHelper.dim('\nPublic SSH Key:'));
    console.log(UIHelper.highlight(publicKey.trim()));
  }
}

export async function keyCommand(action: string, identityName?: string): Promise<void> {
  switch (action) {
    case 'show':
      await showKey(identityName);
      break;
    case 'copy':
      await copyKey(identityName);
      break;
    case 'rotate':
      await rotateKey(identityName);
      break;
    default:
      fail(`Unknown key action "${action}". Use "show", "copy", or "rotate".`);
  }
}
