import { exec } from "child_process";
import os from "os";
import fs from "fs-extra";
import path from "path";

export async function setGitHubSSHKey(sshKeyPath: string) {
  const sshConfigPath = path.join(os.homedir(), '.ssh', 'config');
  const hostConfig = `Host github.com\n  HostName github.com\n  User git\n  IdentityFile ${sshKeyPath}\n  IdentitiesOnly yes\n`;

  try {
    await fs.ensureFile(sshConfigPath);

    let sshConfig = await fs.readFile(sshConfigPath, 'utf8');

    // Check if there's already a config for github.com
    const githubConfigIndex = sshConfig.indexOf('Host github.com');
    if (githubConfigIndex !== -1) {
      // Update existing config
      const nextHostIndex = sshConfig.indexOf('Host ', githubConfigIndex + 1);
      if (nextHostIndex !== -1) {
        sshConfig = sshConfig.slice(0, githubConfigIndex) + hostConfig + sshConfig.slice(nextHostIndex);
      } else {
        sshConfig = sshConfig.slice(0, githubConfigIndex) + hostConfig;
      }
    } else {
      sshConfig += `\n${hostConfig}`;
    }

    await fs.writeFile(sshConfigPath, sshConfig);
    console.log('SSH config for GitHub updated successfully.');
  } catch (error) {
    console.error('Failed to update SSH config for GitHub:', error);
  }
}

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
