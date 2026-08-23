import { execFile } from "child_process";
import { promisify } from 'util';
import os from "os";
import fs from "fs-extra";
import path from "path";
// LAYER VIOLATION (flagged, not fixed — see task-2-report.md "Concerns"):
// these functions print via UIHelper/fail on success/failure paths that are
// interleaved with control flow in their callers (e.g. switchSpace keeps
// going after a failed setGitHubSSHKey/removeSSHKeyFromAgent because these
// call fail() internally instead of throwing). Inverting to "throw/return,
// print in the command layer" would change that control flow, which the
// brief says to avoid — so the UIHelper/fail imports stay here.
import { UIHelper } from "../commands/ui";
import { safeConfirm } from "../commands/prompts";
import { fail } from "../commands/fail";

const execFileAsync = promisify(execFile);

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
    fail('Failed to update SSH config for GitHub: ' + (error as Error).message);
  }
}

export async function removeSSHKeyFromAgent(sshKeyPath: string): Promise<void> {
  try {
    await execFileAsync('ssh-add', ['-d', sshKeyPath]);
    UIHelper.success("SSH key removed from ssh-agent successfully.");
  } catch (error) {
    fail("Error removing SSH key from ssh-agent: " + (error as Error).message);
  }
}

export async function testGithubAccess(sshKeyPath: string): Promise<void> {
  UIHelper.printHeader("Testing SSH Access to GitHub");

  try {
    await execFileAsync('ssh-add', [sshKeyPath]);

    try {
      await execFileAsync('ssh', ['-T', 'git@github.com']);
      UIHelper.success("🎉 Space configuration works! You've successfully authenticated with GitHub.");
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? '';
      if (stderr.includes("successfully authenticated")) {
        UIHelper.success("🎉 Space configuration works! You've successfully authenticated with GitHub.");
      } else {
        fail("🚨 Error testing SSH access to GitHub: " + (error as Error).message);
      }
    }

    const showPublicKey = await safeConfirm({
      message: "Would you like to see the public SSH key?",
      default: false,
    });

    if (!showPublicKey) return;
    const publicKeyPath = `${sshKeyPath}.pub`;
    const publicKey = await fs.readFile(publicKeyPath, 'utf8');
    console.log(UIHelper.dim("\nPublic SSH Key:"));
    console.log(UIHelper.highlight(publicKey));
  } catch (error) {
    fail("🚨 Error testing SSH access to GitHub: " + (error as Error).message);
    UIHelper.info("Ensure the SSH key has been added to the ssh-agent and is associated with your GitHub account.");
  }
}
