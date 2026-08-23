import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Sets the global Git user.name and user.email. */
export async function setGitUser(userName: string, email: string): Promise<void> {
  await execFileAsync('git', ['config', '--global', 'user.name', userName]);
  await execFileAsync('git', ['config', '--global', 'user.email', email]);
}

/** Reads the global Git user.name and user.email. */
export async function getGitUser(): Promise<{ userName: string; email: string }> {
  const { stdout: userNameOutput } = await execFileAsync('git', ['config', '--global', 'user.name']);
  const { stdout: emailOutput } = await execFileAsync('git', ['config', '--global', 'user.email']);
  return { userName: userNameOutput.trim(), email: emailOutput.trim() };
}
