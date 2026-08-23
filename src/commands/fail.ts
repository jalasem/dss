import { UIHelper } from "./ui";

export function fail(message: string): void {
  UIHelper.error(message);
  process.exitCode = 1;
}
