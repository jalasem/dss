import { execFile } from 'child_process';
import fs from 'fs-extra';
import path from 'path';
import { generateKey } from '../../src/infra/keys';

jest.mock('child_process');
jest.mock('fs-extra');

const mockExecFile = execFile as unknown as jest.MockedFunction<typeof execFile>;
const mockFs = fs as jest.Mocked<typeof fs>;

describe('infra/keys generateKey', () => {
  const directory = '/mock/home/.dss/spaces/test-space';
  const comment = 'test@example.com';

  beforeEach(() => {
    jest.clearAllMocks();
    (mockFs.ensureDir as jest.Mock).mockResolvedValue(undefined);
    (mockFs.pathExists as unknown as jest.Mock).mockResolvedValue(false);
    (mockFs.move as unknown as jest.Mock).mockResolvedValue(undefined);
    (mockExecFile as unknown as jest.Mock).mockImplementation(
      (_file: string, args: string[], callback: any) => {
        if (args.includes('-lf')) {
          callback(null, { stdout: '256 SHA256:abc123XYZ test@example.com (ED25519)\n', stderr: '' });
        } else {
          callback(null, { stdout: '', stderr: '' });
        }
        return {} as any;
      }
    );
  });

  it('ensures the target directory exists before generating', async () => {
    await generateKey({ directory, algorithm: 'ed25519', comment });

    expect(mockFs.ensureDir).toHaveBeenCalledWith(directory);
  });

  it('builds the ed25519 keygen args with an empty passphrase by default', async () => {
    await generateKey({ directory, algorithm: 'ed25519', comment });

    expect(mockExecFile).toHaveBeenCalledWith(
      'ssh-keygen',
      ['-t', 'ed25519', '-C', comment, '-f', path.join(directory, 'id_ed25519'), '-N', ''],
      expect.any(Function)
    );
  });

  it('passes a provided passphrase via -N', async () => {
    await generateKey({ directory, algorithm: 'ed25519', comment, passphrase: 'hunter2' });

    expect(mockExecFile).toHaveBeenCalledWith(
      'ssh-keygen',
      ['-t', 'ed25519', '-C', comment, '-f', path.join(directory, 'id_ed25519'), '-N', 'hunter2'],
      expect.any(Function)
    );
  });

  it('adds -b 4096 for rsa keys and uses the id_rsa filename', async () => {
    await generateKey({ directory, algorithm: 'rsa', comment });

    expect(mockExecFile).toHaveBeenCalledWith(
      'ssh-keygen',
      ['-t', 'rsa', '-C', comment, '-f', path.join(directory, 'id_rsa'), '-N', '', '-b', '4096'],
      expect.any(Function)
    );
  });

  it('extracts the fingerprint from ssh-keygen -lf output', async () => {
    const keyInfo = await generateKey({ directory, algorithm: 'ed25519', comment });

    expect(mockExecFile).toHaveBeenCalledWith(
      'ssh-keygen',
      ['-lf', path.join(directory, 'id_ed25519.pub')],
      expect.any(Function)
    );
    expect(keyInfo.fingerprint).toBe('SHA256:abc123XYZ');
  });

  it('returns a full IKeyInfo (path, algorithm, createdAt, fingerprint)', async () => {
    const keyInfo = await generateKey({ directory, algorithm: 'ed25519', comment });

    expect(keyInfo.path).toBe(path.join(directory, 'id_ed25519'));
    expect(keyInfo.algorithm).toBe('ed25519');
    expect(keyInfo.fingerprint).toBe('SHA256:abc123XYZ');
    expect(typeof keyInfo.createdAt).toBe('string');
    expect(() => new Date(keyInfo.createdAt as string).toISOString()).not.toThrow();
  });

  it('moves an existing key (and its .pub) to a .old.<epoch> path before generating (rotation safety)', async () => {
    const keyPath = path.join(directory, 'id_ed25519');
    const pubPath = `${keyPath}.pub`;
    (mockFs.pathExists as unknown as jest.Mock).mockImplementation(async (p: string) => {
      return p === keyPath || p === pubPath;
    });

    await generateKey({ directory, algorithm: 'ed25519', comment });

    expect(mockFs.move).toHaveBeenCalledWith(keyPath, expect.stringMatching(/id_ed25519\.old\.\d+$/));
    expect(mockFs.move).toHaveBeenCalledWith(pubPath, expect.stringMatching(/id_ed25519\.pub\.old\.\d+$/));
  });

  it('does not move anything when no existing key is present', async () => {
    await generateKey({ directory, algorithm: 'ed25519', comment });

    expect(mockFs.move).not.toHaveBeenCalled();
  });

  it('propagates an error from ssh-keygen key generation', async () => {
    (mockExecFile as unknown as jest.Mock).mockImplementation(
      (_file: string, _args: string[], callback: any) => {
        callback(new Error('ssh-keygen failed'));
        return {} as any;
      }
    );

    await expect(generateKey({ directory, algorithm: 'ed25519', comment })).rejects.toThrow('ssh-keygen failed');
  });

  it('propagates an error from the fingerprint lookup', async () => {
    (mockExecFile as unknown as jest.Mock).mockImplementation(
      (_file: string, args: string[], callback: any) => {
        if (args.includes('-lf')) {
          callback(new Error('fingerprint lookup failed'));
        } else {
          callback(null, { stdout: '', stderr: '' });
        }
        return {} as any;
      }
    );

    await expect(generateKey({ directory, algorithm: 'ed25519', comment })).rejects.toThrow('fingerprint lookup failed');
  });
});
