import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { generateKey } from '../infra/keys';
import { addToAgent } from '../infra/ssh';
import { copyToClipboard } from '../infra/clipboard';
import { loadStore, saveStore, setIdentityKey, toSpace } from '../infra/store';
import { findIdentity, slugify } from '../core/identity';
import { IIdentity, IStoreV2 } from '../core/types';
import { keySettingsUrl } from '../core/hosts';
import { UIHelper } from './ui';
import { fail } from './fail';
import { guardedConfirm, UsageError } from './prompts';
import { reapplyActiveIdentity } from './spaces';
import { jsonData } from './jsonOutput';

function keySettingsLine(host: string): string {
  const url = keySettingsUrl(host);
  return url ? `${host} SSH Keys: ${url}` : `Add the public key to your ${host} account.`;
}

async function resolveTargetIdentity(store: IStoreV2, identityName?: string): Promise<IIdentity | undefined> {
  if (identityName) {
    const identity = findIdentity(store, identityName);
    if (!identity) {
      fail(`Identity "${identityName}" not found.`);
      return undefined;
    }
    return identity;
  }

  // No positional AND no active identity to fall back to: there is no
  // input left to resolve an identity from at all — this is "missing
  // input the user should have supplied" (Phase 4 exit-2 contract), not
  // an ordinary lookup failure (those — a named-but-unknown identity,
  // above, or an active identity that's since been deleted, below — stay
  // at fail()'s exit 1). Unconditional (not gated by isNonInteractive):
  // there's no picker this could ever fall back to opening, interactive
  // or not.
  if (!store.active) {
    throw new UsageError(
      'Missing required value: pass the identityName argument (no active identity to fall back to)'
    );
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
  UIHelper.print(UIHelper.dim('\nPublic SSH Key:'));
  UIHelper.print(UIHelper.highlight(publicKey.trim()));
  UIHelper.print('');
  UIHelper.info(keySettingsLine(identity.host));

  jsonData({
    name: identity.name,
    algorithm: identity.key.algorithm,
    fingerprint: identity.key.fingerprint ?? null,
    createdAt: identity.key.createdAt ?? null,
    publicKey: publicKey.trim(),
    settingsUrl: keySettingsUrl(identity.host) ?? null,
  });
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
    jsonData({ copied: true, name: identity.name });
  } catch (error) {
    fail(`Failed to copy public key: ${(error as Error).message}`);
  }
}

export async function rotateKey(identityName?: string): Promise<void> {
  const store = await loadStore();
  const identity = await resolveTargetIdentity(store, identityName);
  if (!identity) return;

  const hasExistingKey = Boolean(identity.key);
  // Required-affirm: rotating/replacing a key is a meaningful, one-way
  // action (the old key stops working once the new one is uploaded), so
  // non-interactive mode without -y errors (exit 2) rather than proceeding
  // or silently declining.
  const confirmed = await guardedConfirm({
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

  // Rotating the ACTIVE identity's key changes its path (keyless→keyed, or
  // a migrated legacy-filename identity rotating onto a standard-named
  // file) — without this, active.gitconfig/ssh-config keep pointing at the
  // old/absent key while `dss key rotate` reports success.
  if (store.active && slugify(store.active) === slugify(identity.name)) {
    try {
      await reapplyActiveIdentity(toSpace(identity), store);
    } catch (error) {
      UIHelper.warning(`Key rotated, but re-applying the active identity's global git/SSH config failed: ${(error as Error).message}`);
    }
  }

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
    `Algorithm: ${keyInfo.algorithm}`,
    `Fingerprint: ${keyInfo.fingerprint ?? 'unknown'}`,
    publicKey ? 'Public key copied to clipboard' : 'Public key could not be copied to clipboard',
    keySettingsLine(identity.host)
  ]);

  if (publicKey) {
    UIHelper.print(UIHelper.dim('\nPublic SSH Key:'));
    UIHelper.print(UIHelper.highlight(publicKey.trim()));
  }

  jsonData({
    rotated: identity.name,
    key: { algorithm: keyInfo.algorithm, fingerprint: keyInfo.fingerprint ?? null },
  });
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
