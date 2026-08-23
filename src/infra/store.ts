import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { ISpace, IConfig, IKeyInfo, IIdentity, IStoreV2 } from '../core/types';
import { slugify, findIdentity } from '../core/identity';

export type { IKeyInfo, IIdentity, IBinding, IStoreV2 } from '../core/types';

const CONFIG_DIR = path.join(os.homedir(), '.dss', 'spaces');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

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
    sshKeyPath: identity.key?.path ?? '',
    host: identity.host
  };
}

export function fromSpace(space: ISpace): IIdentity {
  const identity: IIdentity = {
    name: space.name,
    email: space.email,
    userName: space.userName,
    host: space.host ?? 'github.com'
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
 * IIdentity, preserving metadata the ISpace view can't carry — key
 * fingerprint/createdAt, and algorithm when the key path is unchanged —
 * from the identity it was originally derived from. The edited space's own
 * `host` wins when present (an explicit edit); otherwise the original
 * identity's host is preserved rather than resetting to the fromSpace
 * default. Pass `undefined` for a brand-new space (no prior identity to
 * preserve anything from).
 */
export function mergeIdentity(space: ISpace, original: IIdentity | undefined): IIdentity {
  const updated = fromSpace(space);
  if (!original) return updated;

  updated.host = space.host ?? original.host;

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

/**
 * Writes full key metadata (path, algorithm, fingerprint, createdAt) onto
 * the named identity in the store, in place. Needed because the back-compat
 * ISpace view (and therefore persistConfig/mergeIdentity) can't carry a
 * newly generated key's fingerprint/createdAt — callers that just called
 * generateKey() for an identity must set the result here directly, then
 * call saveStore(store) to persist it. Returns false if no matching
 * identity was found.
 */
export function setIdentityKey(store: IStoreV2, identityName: string, key: IKeyInfo): boolean {
  const identity = findIdentity(store, identityName);
  if (!identity) return false;
  identity.key = key;
  return true;
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

export interface ILoadedConfig {
  store: IStoreV2;
  config: IConfig;
  // Tracks which identity each ISpace was derived from (by object identity,
  // stable across in-place edits, filters, and appends) so persistConfig can
  // preserve metadata the ISpace view can't carry (host, key fingerprint/
  // createdAt, ...) instead of wholesale-replacing every identity.
  originalBySpace: Map<ISpace, IIdentity>;
}

/** Loads the store and its back-compat ISpace[] view, tracking each space's
 * originating identity so persistConfig can merge edits without dropping
 * metadata the ISpace view can't carry. */
export async function loadConfig(): Promise<ILoadedConfig> {
  const store = await loadStore();
  const originalBySpace = new Map<ISpace, IIdentity>();
  const spaces = store.identities.map(identity => {
    const space = toSpace(identity);
    originalBySpace.set(space, identity);
    return space;
  });
  const config: IConfig = { spaces, activeSpace: store.active };
  return { store, config, originalBySpace };
}

/** Persists an edited ISpace[] view back to the store, merging each space
 * with the identity it was loaded from (see loadConfig). */
export async function persistConfig(
  store: IStoreV2,
  config: IConfig,
  originalBySpace: Map<ISpace, IIdentity>
): Promise<void> {
  store.identities = config.spaces.map(space => mergeIdentity(space, originalBySpace.get(space)));
  store.active = config.activeSpace;
  await saveStore(store);
}
