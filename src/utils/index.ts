import { exec } from "child_process";
import { promisify } from 'util';
import os from "os";
import fs from "fs-extra";
import path from "path";
import { confirm } from "@inquirer/prompts";

const execAsync = promisify(exec);

export async function setGitHubSSHKey(sshKeyPath: string) {
  const sshConfigPath = path.join(os.homedir(), '.ssh', 'config');
  const hostConfig = `Host github.com\n  HostName github.com\n  User git\n  IdentityFile ${sshKeyPath}\n  IdentitiesOnly yes\n`;

  try {
    await fs.ensureFile(sshConfigPath);

    let sshConfig = await fs.readFile(sshConfigPath, 'utf8');

    const githubConfigIndex = sshConfig.indexOf('Host github.com');
    if (githubConfigIndex !== -1) {
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

export async function removeSSHKeyFromAgent(sshKeyPath: string): Promise<void> {
  try {
    await execAsync(`ssh-add -d ${sshKeyPath}`);
    console.log("SSH key removed from ssh-agent successfully.");
  } catch (error) {
    console.error("Error removing SSH key from ssh-agent:", (error as Error).message);
  }
}

export async function testGithubAccess(sshKeyPath: string): Promise<void> {
  console.log("Testing SSH access to GitHub...\n");

  try {
    await execAsync(`ssh-add ${sshKeyPath}`);

    try {
      const { stdout } = await execAsync('ssh -T git@github.com');
      console.log("🎉 Space configuration works! You've successfully authenticated with GitHub.");
    } catch (error) {
      const { stderr } = error as { stderr: string };
      if (stderr.includes("successfully authenticated")) {
        console.log("🎉 Space configuration works! You've successfully authenticated with GitHub.\n");
      } else {
        console.error("🚨 Error testing SSH access to GitHub:", (error as Error).message);
      }
    }
    
    const showPublicKey = await confirm({
      message: "Would you like to see the public SSH key?",
      default: false,
    });

    if (!showPublicKey) return;
    const publicKeyPath = `${sshKeyPath}.pub`;
    const publicKey = await fs.readFile(publicKeyPath, 'utf8');
    console.log("Here is your public SSH key:\n", publicKey);
  } catch (error) {
    console.error("🚨 Error testing SSH access to GitHub:", (error as Error).message);
    console.log("Ensure the SSH key has been added to the ssh-agent and is associated with your GitHub account.");
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
