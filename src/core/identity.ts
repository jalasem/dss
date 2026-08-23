import { IConfig, ISpace, IStoreV2, IIdentity } from "./types";

export function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "-");
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
