import { exec } from "child_process";
import { promisify } from 'util';
import os from "os";
import fs from "fs-extra";
import path from "path";
import { confirm } from "@inquirer/prompts";
import { UIHelper } from "./ui";

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
    UIHelper.success('SSH config for GitHub updated successfully.');
  } catch (error) {
    UIHelper.error('Failed to update SSH config for GitHub: ' + (error as Error).message);
  }
}

export async function removeSSHKeyFromAgent(sshKeyPath: string): Promise<void> {
  try {
    await execAsync(`ssh-add -d ${sshKeyPath}`);
    UIHelper.success("SSH key removed from ssh-agent successfully.");
  } catch (error) {
    UIHelper.error("Error removing SSH key from ssh-agent: " + (error as Error).message);
  }
}

export async function testGithubAccess(sshKeyPath: string): Promise<void> {
  UIHelper.printHeader("Testing SSH Access to GitHub");

  try {
    await execAsync(`ssh-add ${sshKeyPath}`);

    try {
      await execAsync('ssh -T git@github.com');
      UIHelper.success("🎉 Space configuration works! You've successfully authenticated with GitHub.");
    } catch (error) {
      const { stderr } = error as { stderr: string };
      if (stderr.includes("successfully authenticated")) {
        UIHelper.success("🎉 Space configuration works! You've successfully authenticated with GitHub.");
      } else {
        UIHelper.error("🚨 Error testing SSH access to GitHub: " + (error as Error).message);
      }
    }
    
    const showPublicKey = await confirm({
      message: "Would you like to see the public SSH key?",
      default: false,
    });

    if (!showPublicKey) return;
    const publicKeyPath = `${sshKeyPath}.pub`;
    const publicKey = await fs.readFile(publicKeyPath, 'utf8');
    console.log(UIHelper.dim("\nPublic SSH Key:"));
    console.log(UIHelper.highlight(publicKey));
  } catch (error) {
    UIHelper.error("🚨 Error testing SSH access to GitHub: " + (error as Error).message);
    UIHelper.info("Ensure the SSH key has been added to the ssh-agent and is associated with your GitHub account.");
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
        UIHelper.error(
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
