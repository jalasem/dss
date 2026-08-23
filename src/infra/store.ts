import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { ISpace } from '../utils/types';
import { slugify } from '../utils/spaceLookup';

const CONFIG_DIR = path.join(os.homedir(), '.dss', 'spaces');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

export interface IKeyInfo {
  path: string;
  algorithm: 'ed25519' | 'rsa' | 'unknown';
  createdAt?: string;
  fingerprint?: string;
}

export interface IIdentity {
  name: string;
  email: string;
  userName: string;
  host: string;
  key?: IKeyInfo;
}

export interface IBinding {
  path: string;
  identity: string;
}

export interface IStoreV2 {
  version: 2;
  identities: IIdentity[];
  active?: string;
  bindings: IBinding[];
}

interface IV1Space {
  name: string;
  email: string;
  userName: string;
  sshKeyPath?: string;
}

interface IV1Config {
  spaces?: IV1Space[];
  activeSpace?: string;
}

function emptyStore(): IStoreV2 {
  return { version: 2, identities: [], bindings: [] };
}

function inferAlgorithm(sshKeyPath: string): IKeyInfo['algorithm'] {
  switch (path.basename(sshKeyPath)) {
    case 'id_ed25519':
      return 'ed25519';
    case 'id_rsa':
      return 'rsa';
    default:
      return 'unknown';
  }
}

export function toSpace(identity: IIdentity): ISpace {
  return {
    name: identity.name,
    email: identity.email,
    userName: identity.userName,
    sshKeyPath: identity.key?.path ?? ''
  };
}

export function fromSpace(space: ISpace): IIdentity {
  const identity: IIdentity = {
    name: space.name,
    email: space.email,
    userName: space.userName,
    host: 'github.com'
  };
  if (space.sshKeyPath) {
    identity.key = {
      path: space.sshKeyPath,
      algorithm: inferAlgorithm(space.sshKeyPath)
    };
  }
  return identity;
}

/**
 * Converts an ISpace (as edited via the back-compat view) back into an
 * IIdentity, preserving metadata the ISpace view can't carry — host, key
 * fingerprint/createdAt, and algorithm when the key path is unchanged —
 * from the identity it was originally derived from. Pass `undefined` for a
 * brand-new space (no prior identity to preserve anything from).
 */
export function mergeIdentity(space: ISpace, original: IIdentity | undefined): IIdentity {
  const updated = fromSpace(space);
  if (!original) return updated;

  updated.host = original.host;

  if (updated.key && original.key) {
    updated.key = {
      ...updated.key,
      fingerprint: original.key.fingerprint,
      createdAt: original.key.createdAt,
      algorithm: updated.key.path === original.key.path ? original.key.algorithm : updated.key.algorithm
    };
  }

  return updated;
}

function uniqueSlug(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix++;
  return `${base}-${suffix}`;
}

function migrateV1(v1: IV1Config): IStoreV2 {
  const identities: IIdentity[] = [];
  const takenSlugs = new Set<string>();

  const spaces = Array.isArray(v1.spaces) ? v1.spaces : [];
  for (const space of spaces) {
    const slug = uniqueSlug(slugify(space.name), takenSlugs);
    takenSlugs.add(slug);
    identities.push(fromSpace({
      name: slug,
      email: space.email,
      userName: space.userName,
      sshKeyPath: space.sshKeyPath ?? ''
    }));
  }

  const active = v1.activeSpace ? slugify(v1.activeSpace) : undefined;

  return { version: 2, identities, active, bindings: [] };
}

async function backupIfAbsent(sourcePath: string, backupPath: string): Promise<void> {
  if (await fs.pathExists(backupPath)) return;
  await fs.copy(sourcePath, backupPath);
}

async function writeBackupContentIfAbsent(backupPath: string, content: string): Promise<void> {
  if (await fs.pathExists(backupPath)) return;
  await fs.writeFile(backupPath, content);
}

/** Ensures the config file exists, migrates a v1 file silently, and returns the v2 store. */
export async function loadStore(): Promise<IStoreV2> {
  await fs.ensureDir(CONFIG_DIR);
  await fs.ensureFile(CONFIG_PATH);

  const raw = await fs.readFile(CONFIG_PATH, 'utf8');
  if (!raw.trim()) {
    const fresh = emptyStore();
    await saveStore(fresh);
    return fresh;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await writeBackupContentIfAbsent(`${CONFIG_PATH}.corrupt.bak`, raw);
    const fresh = emptyStore();
    await saveStore(fresh);
    return fresh;
  }

  if (parsed && typeof parsed === 'object' && (parsed as { version?: unknown }).version === 2) {
    const v2 = parsed as Partial<IStoreV2>;
    return {
      version: 2,
      identities: Array.isArray(v2.identities) ? v2.identities : [],
      active: v2.active,
      bindings: Array.isArray(v2.bindings) ? v2.bindings : []
    };
  }

  await backupIfAbsent(CONFIG_PATH, `${CONFIG_PATH}.v1.bak`);
  const migrated = migrateV1((parsed ?? {}) as IV1Config);
  await saveStore(migrated);
  return migrated;
}

/** Atomically writes the store: pretty JSON to a tmp file, then move-overwrite. */
export async function saveStore(store: IStoreV2): Promise<void> {
  await fs.ensureDir(CONFIG_DIR);
  const tmpPath = `${CONFIG_PATH}.tmp`;
  await fs.writeJson(tmpPath, store, { spaces: 2 });
  await fs.move(tmpPath, CONFIG_PATH, { overwrite: true });
}

/** Upserts a binding by canonical repository path. */
export function recordBinding(store: IStoreV2, repositoryPath: string, identity: string): void {
  const existing = store.bindings.find(binding => binding.path === repositoryPath);
  if (existing) {
    existing.identity = identity;
    return;
  }
  store.bindings.push({ path: repositoryPath, identity });
}

/** Removes any binding for a canonical repository path. */
export function removeBinding(store: IStoreV2, repositoryPath: string): void {
  store.bindings = store.bindings.filter(binding => binding.path !== repositoryPath);
}
