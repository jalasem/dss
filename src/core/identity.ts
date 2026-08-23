import { IConfig, ISpace, IStoreV2, IIdentity } from "./types";

export function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "-");
}

// Extracted from addSpace's inline `input` validator so the same charset
// rule can be reused wherever an identity name is accepted from outside a
// fresh addSpace prompt — the rename prompt in modifySpace and the import
// path in batch.ts — both of which can otherwise hand a name straight to
// fs.move/a key directory join (e.g. "../../../tmp/x" escaping ~/.dss).
export function validateIdentityName(name: unknown): true | string {
  if (typeof name !== "string" || !name.trim()) return "Space name is required!";
  if (name.length < 2) return "Space name must be at least 2 characters long";
  if (!/^[a-zA-Z0-9\s\-_]+$/.test(name)) return "Space name can only contain letters, numbers, spaces, hyphens, and underscores";
  return true;
}

export function findSpace(config: IConfig, name: string): ISpace | undefined {
  return config.spaces.find(
    (space) => space.name === name || slugify(space.name) === slugify(name)
  );
}

export function findIdentity(store: IStoreV2, name: string): IIdentity | undefined {
  return store.identities.find(
    (identity) => identity.name === name || slugify(identity.name) === slugify(name)
  );
}
