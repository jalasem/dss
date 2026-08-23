import { spawn } from "child_process";
// LAYER VIOLATION (flagged, not fixed — see task-2-report.md "Concerns"):
// the unsupported-platform branch prints via UIHelper before rejecting.
// Dropping that print would be a behavior change (a message callers
// currently see would disappear), so the import stays here rather than
// being inverted to a bare throw.
import { UIHelper } from "../commands/ui";

export const copyToClipboard = (publicKey: string) => {
  return new Promise((resolve, reject) => {
    // Platform-specific command to copy the SSH public key to clipboard
    let command: string;
    let args: string[];
    switch (process.platform) {
      case "darwin":
        command = "pbcopy";
        args = [];
        break;
      case "win32":
        command = "clip";
        args = [];
        break;
      case "linux":
        command = "xclip";
        args = ["-selection", "clipboard"];
        break;
      default:
        UIHelper.error(
          `Platform ${process.platform} is not supported for clipboard operations.`
        );
        reject(new Error("Unsupported platform for clipboard operations."));
        return;
    }

    const child = spawn(command, args);
    let settled = false;

    const settleOnce = (action: () => void) => {
      if (settled) return;
      settled = true;
      action();
    };

    child.on("error", (error) => {
      settleOnce(() => reject(error));
    });

    // Without this handler, an error on the stdin pipe (e.g. the binary
    // exits before the write completes) is an unhandled 'error' event on
    // the stream, which Node treats as an uncaught exception and crashes
    // the process instead of surfacing as a rejected promise.
    child.stdin.on("error", (error) => {
      settleOnce(() => reject(error));
    });

    child.on("close", (code) => {
      settleOnce(() => {
        if (code === 0) {
          resolve("Public SSH key copied to clipboard.");
        } else {
          reject(new Error(`${command} exited with code ${code}`));
        }
      });
    });

    child.stdin.write(publicKey);
    child.stdin.end();
  });
};
