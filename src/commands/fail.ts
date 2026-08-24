import { UIHelper } from "./ui";
import { EXIT_CODES } from "../core/exitCodes";
import { isJsonMode, jsonFail } from "./jsonOutput";

export function fail(message: string): void {
  UIHelper.error(message);
  if (isJsonMode()) jsonFail(message);
  process.exitCode = EXIT_CODES.FAILURE;
}
