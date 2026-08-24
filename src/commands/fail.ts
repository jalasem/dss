import { UIHelper } from "./ui";
import { EXIT_CODES } from "../core/exitCodes";

export function fail(message: string): void {
  UIHelper.error(message);
  process.exitCode = EXIT_CODES.FAILURE;
}
