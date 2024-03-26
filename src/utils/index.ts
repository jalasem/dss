import { exec } from "child_process";

export const copyToClipboard = (publicKey: string) => {
  return new Promise((resolve, reject) => {
    // Platform-specific command to copy the SSH public key to clipboard
    let copyCommand;
    switch (process.platform) {
      case "darwin":
        copyCommand = "pbcopy";
        break;
      case "win32":
        copyCommand = "clip";
        break;
      case "linux":
        copyCommand = "xclip -selection clipboard";
        break;
      default:
        console.error(
          `Platform ${process.platform} is not supported for clipboard operations.`
        );
        reject(new Error("Unsupported platform for clipboard operations."));
        return;
    }

    exec(`echo "${publicKey}" | ${copyCommand}`, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve("Public SSH key copied to clipboard.");
      }
    });
  });
};
