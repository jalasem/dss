import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs-extra';
import path from 'path';
import { IKeyInfo } from '../core/types';

const execFileAsync = promisify(execFile);

export interface IGenerateKeyOptions {
  directory: string;
  algorithm: 'ed25519' | 'rsa';
  comment: string;
  passphrase?: string;
}

function keyFilename(algorithm: 'ed25519' | 'rsa'): string {
  return algorithm === 'ed25519' ? 'id_ed25519' : 'id_rsa';
}

// Rotation safety: never overwrite a key file that already exists — move it
// (and its .pub counterpart) out of the way first.
async function archiveIfExists(filePath: string, epoch: number): Promise<void> {
  if (!(await fs.pathExists(filePath))) return;
  await fs.move(filePath, `${filePath}.old.${epoch}`);
}

async function extractFingerprint(publicKeyPath: string): Promise<string | undefined> {
  const { stdout } = await execFileAsync('ssh-keygen', ['-lf', publicKeyPath]);
  return stdout.match(/SHA256:\S+/)?.[0];
}

/** Generates a new SSH key pair via the system ssh-keygen binary. */
export async function generateKey(opts: IGenerateKeyOptions): Promise<IKeyInfo> {
  await fs.ensureDir(opts.directory);

  const keyPath = path.join(opts.directory, keyFilename(opts.algorithm));
  const publicKeyPath = `${keyPath}.pub`;

  const epoch = Date.now();
  await archiveIfExists(keyPath, epoch);
  await archiveIfExists(publicKeyPath, epoch);

  const args = ['-t', opts.algorithm, '-C', opts.comment, '-f', keyPath, '-N', opts.passphrase ?? ''];
  if (opts.algorithm === 'rsa') {
    args.push('-b', '4096');
  }

  await execFileAsync('ssh-keygen', args);

  const fingerprint = await extractFingerprint(publicKeyPath);

  return {
    path: keyPath,
    algorithm: opts.algorithm,
    createdAt: new Date().toISOString(),
    fingerprint
  };
}
