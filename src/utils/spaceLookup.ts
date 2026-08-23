import { IConfig, ISpace } from "./types";

export function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "-");
}

export function findSpace(config: IConfig, name: string): ISpace | undefined {
  return config.spaces.find(
    (space) => space.name === name || slugify(space.name) === slugify(name)
  );
}
