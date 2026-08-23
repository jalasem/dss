import { execFile } from 'child_process';
import fs from 'fs-extra';
import os from 'os';
import { confirm } from '@inquirer/prompts';
import {
  parseSshConfig,
  serialize,
  applyHostSSHKey,
  setHostSSHKey,
  removeSSHKeyFromAgent,
  testHostAccess,
  addToAgent,
  checkKeyLoadedInAgent,
  checkSshConfigHost
} from '../../src/infra/ssh';

jest.mock('child_process');
jest.mock('fs-extra');
jest.mock('@inquirer/prompts', () => ({
  confirm: jest.fn(),
  select: jest.fn(),
  input: jest.fn()
}));

const mockExecFile = execFile as unknown as jest.MockedFunction<typeof execFile>;
const mockFs = fs as jest.Mocked<typeof fs>;
const mockConfirm = confirm as jest.MockedFunction<typeof confirm>;

describe('infra/ssh', () => {
  const mockHomeDir = '/mock/home';
  const mockSshKeyPath = '/mock/home/.dss/spaces/test-space/id_rsa';
  const mockSshConfigPath = '/mock/home/.ssh/config';
  const mockBackupPath = '/mock/home/.ssh/config.dss.bak';

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(os, 'homedir').mockReturnValue(mockHomeDir);
    mockConfirm.mockResolvedValue(false as never);
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  // ---------------------------------------------------------------------
  // parseSshConfig / serialize — round-trip parser
  // ---------------------------------------------------------------------

  describe('parseSshConfig / serialize (round-trip)', () => {
    const fixture = [
      '# global comment',
      'AddKeysToAgent yes',
      '',
      'Host github.com-work',
      '  HostName github.com',
      '  User git',
      '  IdentityFile ~/.ssh/id_work',
      '',
      'Host a b',
      '  User git',
      '',
      'Match host "*.internal.example.com"',
      '  ProxyJump bastion',
      '',
      'Host github.com',
      '  HostName github.com',
      '  User git',
      '  IdentityFile /old/path/id_rsa',
      '  IdentitiesOnly yes',
      '  ProxyJump bastion2',
      ''
    ].join('\n');

    it('reproduces an untouched fixture byte-for-byte through parse -> serialize', () => {
      const parsed = parseSshConfig(fixture);
      expect(serialize(parsed)).toBe(fixture);
    });

    it('parses the preamble as the lines before the first Host/Match directive', () => {
      const parsed = parseSshConfig(fixture);
      expect(parsed.preamble).toEqual(['# global comment', 'AddKeysToAgent yes', '']);
    });

    it('parses each Host/Match line into an ordered block with its pattern list', () => {
      const parsed = parseSshConfig(fixture);
      expect(parsed.blocks.map((b) => ({ keyword: b.keyword, patterns: b.patterns }))).toEqual([
        { keyword: 'Host', patterns: ['github.com-work'] },
        { keyword: 'Host', patterns: ['a', 'b'] },
        { keyword: 'Match', patterns: [] },
        { keyword: 'Host', patterns: ['github.com'] }
      ]);
    });

    it('modifying only the target block\'s managed lines leaves every other block byte-identical', () => {
      const parsed = parseSshConfig(fixture);
      const updated = applyHostSSHKey(fixture, mockSshKeyPath, 'github.com');
      const reparsed = parseSshConfig(updated);

      // Sibling blocks: untouched, byte-for-byte.
      expect(reparsed.preamble).toEqual(parsed.preamble);
      expect(reparsed.blocks[0]).toEqual(parsed.blocks[0]); // github.com-work
      expect(reparsed.blocks[1]).toEqual(parsed.blocks[1]); // Host a b
      expect(reparsed.blocks[2]).toEqual(parsed.blocks[2]); // Match block

      // Target block: only the four managed lines changed; ProxyJump preserved.
      const targetBlock = reparsed.blocks[3];
      expect(targetBlock.headerLine).toBe('Host github.com');
      expect(targetBlock.lines).toContain('  ProxyJump bastion2');
      expect(targetBlock.lines).toContain(`  IdentityFile ${mockSshKeyPath}`);
      expect(targetBlock.lines).not.toContain('  IdentityFile /old/path/id_rsa');
    });

    it('never matches a multi-pattern block, a differently-named block, or a Match block', () => {
      // None of "github.com-work", "a b", or the Match block should be
      // touched when targeting "github.com" (asserted above); confirm here
      // that targeting one of those literal names/patterns as a whole
      // "host" also does not match a multi-pattern block.
      const updated = applyHostSSHKey(fixture, '/new/key', 'a');
      const reparsed = parseSshConfig(updated);
      // "Host a b" (two patterns) must be untouched; a new "Host a" block
      // gets appended instead.
      const multiPatternBlock = reparsed.blocks.find((b) => b.patterns.length === 2);
      expect(multiPatternBlock?.lines).toEqual(['  User git', '']);
      const appended = reparsed.blocks[reparsed.blocks.length - 1];
      expect(appended.headerLine).toBe('Host a');
    });

    it('adopts an old splice-created "Host github.com" block in place (no duplicate)', () => {
      const spliced = 'Host github.com\n  HostName github.com\n  User git\n  IdentityFile /old/id_rsa\n  IdentitiesOnly yes\n';
      const updated = applyHostSSHKey(spliced, '/new/id_rsa', 'github.com');
      const reparsed = parseSshConfig(updated);

      const hostBlocks = reparsed.blocks.filter((b) => b.patterns.length === 1 && b.patterns[0] === 'github.com');
      expect(hostBlocks).toHaveLength(1);
      expect(hostBlocks[0].lines).toContain('  IdentityFile /new/id_rsa');
    });

    it('appends a new block at the end when no matching block exists', () => {
      const content = 'Host other.com\n  User git\n';
      const updated = applyHostSSHKey(content, '/new/id_ed25519', 'gitlab.com');
      const reparsed = parseSshConfig(updated);

      expect(reparsed.blocks).toHaveLength(2);
      expect(reparsed.blocks[0].headerLine).toBe('Host other.com'); // untouched
      const appended = reparsed.blocks[1];
      expect(appended.headerLine).toBe('Host gitlab.com');
      expect(appended.lines).toEqual([
        '  HostName gitlab.com',
        '  User git',
        '  IdentityFile /new/id_ed25519',
        '  IdentitiesOnly yes'
      ]);
    });

    it('appends cleanly to a genuinely empty file (no leading blank line)', () => {
      const updated = applyHostSSHKey('', '/new/id_ed25519', 'github.com');
      expect(updated).toBe(
        'Host github.com\n  HostName github.com\n  User git\n  IdentityFile /new/id_ed25519\n  IdentitiesOnly yes'
      );
    });

    it('quotes the IdentityFile value when the key path contains whitespace', () => {
      const spacedPath = '/tmp/my dir/id_rsa';
      const updated = applyHostSSHKey('', spacedPath, 'github.com');
      const reparsed = parseSshConfig(updated);
      expect(reparsed.blocks[0].lines).toContain(`  IdentityFile "${spacedPath}"`);
    });

    it('does not quote an IdentityFile value with no whitespace', () => {
      const updated = applyHostSSHKey('', mockSshKeyPath, 'github.com');
      const reparsed = parseSshConfig(updated);
      expect(reparsed.blocks[0].lines).toContain(`  IdentityFile ${mockSshKeyPath}`);
    });

    // Security: a crafted `host` or `sshKeyPath` containing a line break
    // could inject an arbitrary extra ssh_config directive (e.g. a
    // ProxyCommand) into the globally-applied ~/.ssh/config. This is the
    // last-line hard gate — it must throw regardless of what validation an
    // upstream caller (import filter, prompt) does or doesn't have.
    it('throws when host contains an embedded ssh_config directive via a line break', () => {
      expect(() => applyHostSSHKey('', mockSshKeyPath, 'github.com\n  ProxyCommand /bin/sh -c "evil"'))
        .toThrow(/line break/);
    });

    it('throws when host contains a carriage return', () => {
      expect(() => applyHostSSHKey('', mockSshKeyPath, 'github.com\r  ProxyCommand evil'))
        .toThrow(/line break/);
    });

    it('throws when sshKeyPath contains a line break', () => {
      expect(() => applyHostSSHKey('', '/some/path\n  ProxyCommand evil', 'github.com'))
        .toThrow(/line break/);
    });
  });

  // ---------------------------------------------------------------------
  // setHostSSHKey — orchestration: read, backup, write, chmod, no-op
  // ---------------------------------------------------------------------

  describe('setHostSSHKey', () => {
    it('creates a new SSH config block for a fresh host and backs up first', async () => {
      (mockFs.pathExists as unknown as jest.Mock).mockResolvedValue(false);
      (mockFs.ensureFile as jest.Mock).mockResolvedValue(undefined);
      (mockFs.chmod as unknown as jest.Mock).mockResolvedValue(undefined);
      (mockFs.readFile as unknown as jest.Mock).mockResolvedValue('');
      (mockFs.copy as unknown as jest.Mock).mockResolvedValue(undefined);
      (mockFs.writeFile as unknown as jest.Mock).mockResolvedValue(undefined);

      await setHostSSHKey(mockSshKeyPath, 'github.com');

      expect(mockFs.ensureFile).toHaveBeenCalledWith(mockSshConfigPath);
      expect(mockFs.chmod).toHaveBeenCalledWith(mockSshConfigPath, 0o600);
      expect(mockFs.copy).toHaveBeenCalledWith(mockSshConfigPath, mockBackupPath, { overwrite: true });
      expect(mockFs.writeFile).toHaveBeenCalledWith(
        mockSshConfigPath,
        expect.stringContaining('Host github.com')
      );
      expect(mockFs.writeFile).toHaveBeenCalledWith(
        mockSshConfigPath,
        expect.stringContaining(mockSshKeyPath)
      );
    });

    it('does not chmod an already-existing config file', async () => {
      (mockFs.pathExists as unknown as jest.Mock).mockResolvedValue(true);
      (mockFs.ensureFile as jest.Mock).mockResolvedValue(undefined);
      (mockFs.readFile as unknown as jest.Mock).mockResolvedValue('');
      (mockFs.copy as unknown as jest.Mock).mockResolvedValue(undefined);
      (mockFs.writeFile as unknown as jest.Mock).mockResolvedValue(undefined);

      await setHostSSHKey(mockSshKeyPath, 'github.com');

      expect(mockFs.chmod).not.toHaveBeenCalled();
    });

    it('adopts an old splice-created "Host github.com" block in place', async () => {
      const existingConfig = `Host github.com
  HostName github.com
  User git
  IdentityFile /old/path/id_rsa
  IdentitiesOnly yes

Host other.com
  HostName other.com
  User git`;

      (mockFs.pathExists as unknown as jest.Mock).mockResolvedValue(true);
      (mockFs.ensureFile as jest.Mock).mockResolvedValue(undefined);
      (mockFs.readFile as unknown as jest.Mock).mockResolvedValue(existingConfig);
      (mockFs.copy as unknown as jest.Mock).mockResolvedValue(undefined);
      (mockFs.writeFile as unknown as jest.Mock).mockResolvedValue(undefined);

      await setHostSSHKey(mockSshKeyPath, 'github.com');

      expect(mockFs.writeFile).toHaveBeenCalledWith(
        mockSshConfigPath,
        expect.stringContaining(mockSshKeyPath)
      );
      expect(mockFs.writeFile).toHaveBeenCalledWith(
        mockSshConfigPath,
        expect.stringContaining('Host other.com')
      );
      const written = (mockFs.writeFile as unknown as jest.Mock).mock.calls[0][1] as string;
      expect(written.match(/Host github\.com\b/g)).toHaveLength(1);
    });

    it('skips the write (and backup) when the resulting content is unchanged', async () => {
      const alreadyCurrent = `Host github.com\n  HostName github.com\n  User git\n  IdentityFile ${mockSshKeyPath}\n  IdentitiesOnly yes`;

      (mockFs.pathExists as unknown as jest.Mock).mockResolvedValue(true);
      (mockFs.ensureFile as jest.Mock).mockResolvedValue(undefined);
      (mockFs.readFile as unknown as jest.Mock).mockResolvedValue(alreadyCurrent);

      await setHostSSHKey(mockSshKeyPath, 'github.com');

      expect(mockFs.copy).not.toHaveBeenCalled();
      expect(mockFs.writeFile).not.toHaveBeenCalled();
    });

    it('handles errors gracefully', async () => {
      (mockFs.pathExists as unknown as jest.Mock).mockResolvedValue(true);
      (mockFs.ensureFile as jest.Mock).mockRejectedValue(new Error('Permission denied'));

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      await setHostSSHKey(mockSshKeyPath, 'github.com');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to update SSH config for github.com: Permission denied')
      );

      consoleSpy.mockRestore();
    });

    it('surfaces a crafted-host injection attempt via fail() (exit code 1) rather than writing the config', async () => {
      (mockFs.pathExists as unknown as jest.Mock).mockResolvedValue(true);
      (mockFs.ensureFile as jest.Mock).mockResolvedValue(undefined);
      (mockFs.readFile as unknown as jest.Mock).mockResolvedValue('');

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      await setHostSSHKey(mockSshKeyPath, 'github.com\n  ProxyCommand /bin/sh -c "evil"');

      expect(mockFs.writeFile).not.toHaveBeenCalled();
      expect(mockFs.copy).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('line break'));
      expect(process.exitCode).toBe(1);

      consoleSpy.mockRestore();
    });
  });

  describe('addToAgent', () => {
    const originalPlatform = process.platform;

    function setPlatform(value: NodeJS.Platform): void {
      Object.defineProperty(process, 'platform', { value, configurable: true });
    }

    afterEach(() => {
      setPlatform(originalPlatform);
    });

    it('uses ssh-add --apple-use-keychain on darwin', async () => {
      setPlatform('darwin');
      (mockExecFile as unknown as jest.Mock).mockImplementation(
        (_file: string, _args: string[], callback: any) => {
          callback(null, { stdout: '', stderr: '' });
          return {} as any;
        }
      );

      await addToAgent(mockSshKeyPath);

      expect(mockExecFile).toHaveBeenCalledWith(
        'ssh-add',
        ['--apple-use-keychain', mockSshKeyPath],
        expect.any(Function)
      );
    });

    it('falls back to plain ssh-add on darwin when --apple-use-keychain errors', async () => {
      setPlatform('darwin');
      (mockExecFile as unknown as jest.Mock).mockImplementation(
        (_file: string, args: string[], callback: any) => {
          if (args.includes('--apple-use-keychain')) {
            callback(new Error('unknown option -- apple-use-keychain'));
          } else {
            callback(null, { stdout: '', stderr: '' });
          }
          return {} as any;
        }
      );

      await addToAgent(mockSshKeyPath);

      expect(mockExecFile).toHaveBeenCalledWith(
        'ssh-add',
        ['--apple-use-keychain', mockSshKeyPath],
        expect.any(Function)
      );
      expect(mockExecFile).toHaveBeenCalledWith(
        'ssh-add',
        [mockSshKeyPath],
        expect.any(Function)
      );
    });

    it('uses plain ssh-add on non-darwin platforms (no keychain flag attempted)', async () => {
      setPlatform('linux');
      (mockExecFile as unknown as jest.Mock).mockImplementation(
        (_file: string, _args: string[], callback: any) => {
          callback(null, { stdout: '', stderr: '' });
          return {} as any;
        }
      );

      await addToAgent(mockSshKeyPath);

      expect(mockExecFile).toHaveBeenCalledWith(
        'ssh-add',
        [mockSshKeyPath],
        expect.any(Function)
      );
      expect(mockExecFile).not.toHaveBeenCalledWith(
        'ssh-add',
        expect.arrayContaining(['--apple-use-keychain']),
        expect.any(Function)
      );
    });

    it('propagates an error when the plain ssh-add fallback also fails on darwin', async () => {
      setPlatform('darwin');
      (mockExecFile as unknown as jest.Mock).mockImplementation(
        (_file: string, _args: string[], callback: any) => {
          callback(new Error('ssh-add failed'));
          return {} as any;
        }
      );

      await expect(addToAgent(mockSshKeyPath)).rejects.toThrow('ssh-add failed');
    });

    it('passes an SSH key path containing a space to ssh-add as a single execFile argument (regression)', async () => {
      setPlatform('darwin');
      const spacedKeyPath = '/tmp/my dir/id_rsa';
      (mockExecFile as unknown as jest.Mock).mockImplementation(
        (_file: string, _args: string[], callback: any) => {
          callback(null, { stdout: '', stderr: '' });
          return {} as any;
        }
      );

      await addToAgent(spacedKeyPath);

      expect(mockExecFile).toHaveBeenCalledWith(
        'ssh-add',
        ['--apple-use-keychain', spacedKeyPath],
        expect.any(Function)
      );
    });
  });

  describe('removeSSHKeyFromAgent', () => {
    it('should remove SSH key from agent successfully', async () => {
      (mockExecFile as unknown as jest.Mock).mockImplementation(
        (_file: string, _args: string[], callback: any) => {
          callback(null, { stdout: '', stderr: '' });
          return {} as any;
        }
      );

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      await removeSSHKeyFromAgent(mockSshKeyPath);

      expect(mockExecFile).toHaveBeenCalledWith(
        'ssh-add',
        ['-d', mockSshKeyPath],
        expect.any(Function)
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('SSH key removed from ssh-agent successfully.')
      );

      consoleSpy.mockRestore();
    });

    it('should handle errors when removing SSH key', async () => {
      (mockExecFile as unknown as jest.Mock).mockImplementation(
        (_file: string, _args: string[], callback: any) => {
          callback(new Error('Key not found'));
          return {} as any;
        }
      );

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      await removeSSHKeyFromAgent(mockSshKeyPath);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error removing SSH key from ssh-agent: Key not found')
      );

      consoleSpy.mockRestore();
    });

    it('passes an SSH key path containing a space to ssh-add as a single execFile argument (regression)', async () => {
      const spacedKeyPath = '/tmp/my dir/id_rsa';
      (mockExecFile as unknown as jest.Mock).mockImplementation(
        (_file: string, _args: string[], callback: any) => {
          callback(null, { stdout: '', stderr: '' });
          return {} as any;
        }
      );

      await removeSSHKeyFromAgent(spacedKeyPath);

      expect(mockExecFile).toHaveBeenCalledWith(
        'ssh-add',
        ['-d', spacedKeyPath],
        expect.any(Function)
      );
    });
  });

  describe('testHostAccess', () => {
    it('uses -i/-o IdentitiesOnly=yes with the given host and does NOT ssh-add the key first (behavior change from testGithubAccess)', async () => {
      (mockExecFile as unknown as jest.Mock).mockImplementation(
        (_file: string, _args: string[], callback: any) => {
          callback(null, { stdout: '', stderr: '' });
          return {} as any;
        }
      );
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      await testHostAccess(mockSshKeyPath, 'github.com');

      expect(mockExecFile).toHaveBeenCalledWith(
        'ssh',
        ['-i', mockSshKeyPath, '-o', 'IdentitiesOnly=yes', '-T', 'git@github.com'],
        expect.any(Function)
      );
      expect(mockExecFile).not.toHaveBeenCalledWith(
        'ssh-add',
        expect.anything(),
        expect.any(Function)
      );

      consoleSpy.mockRestore();
    });

    it('succeeds on a zero exit code', async () => {
      (mockExecFile as unknown as jest.Mock).mockImplementation(
        (_file: string, _args: string[], callback: any) => {
          callback(null, { stdout: '', stderr: '' });
          return {} as any;
        }
      );
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      await testHostAccess(mockSshKeyPath, 'github.com');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('successfully authenticated with github.com')
      );
      consoleSpy.mockRestore();
    });

    it.each([
      ['github.com', 'successfully authenticated'],
      ['gitlab.com', 'Welcome to GitLab'],
      ['bitbucket.org', 'logged in as'],
      ['bitbucket.org', 'authenticated via']
    ])('treats a non-zero exit on %s containing "%s" as success', async (host, marker) => {
      (mockExecFile as unknown as jest.Mock).mockImplementation(
        (file: string, _args: string[], callback: any) => {
          if (file === 'ssh') {
            const error: any = new Error('Command failed');
            error.stderr = `Hi there! ${marker}, but shell access is not provided.`;
            callback(error);
          } else {
            callback(null, { stdout: '', stderr: '' });
          }
          return {} as any;
        }
      );
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      await testHostAccess(mockSshKeyPath, host);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining(`successfully authenticated with ${host}`)
      );
      consoleSpy.mockRestore();
    });

    it('also recognizes a success marker in stdout (not just stderr)', async () => {
      (mockExecFile as unknown as jest.Mock).mockImplementation(
        (file: string, _args: string[], callback: any) => {
          if (file === 'ssh') {
            const error: any = new Error('Command failed');
            error.stdout = 'Welcome to GitLab, @someone!';
            callback(error);
          } else {
            callback(null, { stdout: '', stderr: '' });
          }
          return {} as any;
        }
      );
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      await testHostAccess(mockSshKeyPath, 'gitlab.com');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('successfully authenticated with gitlab.com')
      );
      consoleSpy.mockRestore();
    });

    it('fails (exit 1) on a genuine non-zero exit with no known success marker', async () => {
      (mockExecFile as unknown as jest.Mock).mockImplementation(
        (file: string, _args: string[], callback: any) => {
          if (file === 'ssh') {
            const error: any = new Error('Permission denied (publickey).');
            error.stderr = 'Permission denied (publickey).';
            callback(error);
          } else {
            callback(null, { stdout: '', stderr: '' });
          }
          return {} as any;
        }
      );
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      await testHostAccess(mockSshKeyPath, 'github.com');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error testing SSH access to github.com')
      );
      expect(process.exitCode).toBe(1);
      consoleSpy.mockRestore();
    });

    it('does not throw when an "ssh -T" spawn failure has no stderr/stdout property (regression)', async () => {
      (mockExecFile as unknown as jest.Mock).mockImplementation(
        (file: string, _args: string[], callback: any) => {
          if (file === 'ssh') {
            // A spawn-level failure (e.g. ENOENT, killed by signal) yields
            // an error object with no `stderr`/`stdout` at all.
            callback(new Error('spawn ssh ENOENT'));
          } else {
            callback(null, { stdout: '', stderr: '' });
          }
          return {} as any;
        }
      );
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      await expect(testHostAccess(mockSshKeyPath, 'github.com')).resolves.toBeUndefined();

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error testing SSH access to github.com: spawn ssh ENOENT')
      );

      consoleSpy.mockRestore();
    });

    it('passes an SSH key path containing a space as a single execFile argument (regression)', async () => {
      const spacedKeyPath = '/tmp/my dir/id_rsa';
      (mockExecFile as unknown as jest.Mock).mockImplementation(
        (_file: string, _args: string[], callback: any) => {
          callback(null, { stdout: '', stderr: '' });
          return {} as any;
        }
      );
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      await testHostAccess(spacedKeyPath, 'github.com');

      expect(mockExecFile).toHaveBeenCalledWith(
        'ssh',
        ['-i', spacedKeyPath, '-o', 'IdentitiesOnly=yes', '-T', 'git@github.com'],
        expect.any(Function)
      );

      consoleSpy.mockRestore();
    });
  });

  // ---------------------------------------------------------------------
  // checkKeyLoadedInAgent — the cheap, local-only fingerprint/agent check
  // shared by the bare-`dss` dashboard and `dss doctor` (extracted from
  // the old inspectSpace's inline duplicate of this logic).
  // ---------------------------------------------------------------------

  describe('checkKeyLoadedInAgent', () => {
    it('reports loaded: true when the fingerprint appears in ssh-add -l output', async () => {
      (mockExecFile as unknown as jest.Mock).mockImplementation((file: string, _args: string[], cb: any) => {
        if (file === 'ssh-keygen') {
          cb(null, { stdout: '2048 SHA256:abc123DEF comment (RSA)\n', stderr: '' });
        } else if (file === 'ssh-add') {
          cb(null, { stdout: '2048 SHA256:abc123DEF comment (RSA)\n', stderr: '' });
        }
      });

      const result = await checkKeyLoadedInAgent(`${mockSshKeyPath}.pub`);

      expect(result).toEqual({ fingerprint: 'SHA256:abc123DEF', loaded: true, checked: true });
    });

    it('reports loaded: false (but checked: true) when the fingerprint is absent from ssh-add -l', async () => {
      (mockExecFile as unknown as jest.Mock).mockImplementation((file: string, _args: string[], cb: any) => {
        if (file === 'ssh-keygen') {
          cb(null, { stdout: '2048 SHA256:abc123DEF comment (RSA)\n', stderr: '' });
        } else if (file === 'ssh-add') {
          cb(null, { stdout: '2048 SHA256:zzz999OTHER comment (RSA)\n', stderr: '' });
        }
      });

      const result = await checkKeyLoadedInAgent(`${mockSshKeyPath}.pub`);

      expect(result).toEqual({ fingerprint: 'SHA256:abc123DEF', loaded: false, checked: true });
    });

    it('reports checked: false when ssh-keygen/ssh-add fails (e.g. no agent running) rather than a false negative', async () => {
      (mockExecFile as unknown as jest.Mock).mockImplementation((_file: string, _args: string[], cb: any) =>
        cb(new Error('Could not open a connection to your authentication agent'))
      );

      const result = await checkKeyLoadedInAgent(`${mockSshKeyPath}.pub`);

      expect(result).toEqual({ loaded: false, checked: false });
    });
  });

  // ---------------------------------------------------------------------
  // checkSshConfigHost — matches doctor's "✓ match / ! points elsewhere /
  // ! absent" ssh-config check against the same single-pattern `Host
  // <host>` block applyHostSSHKey manages.
  // ---------------------------------------------------------------------

  describe('checkSshConfigHost', () => {
    it('returns "absent" when ~/.ssh/config does not exist', async () => {
      (mockFs.pathExists as unknown as jest.Mock).mockResolvedValue(false);

      await expect(checkSshConfigHost('github.com', mockSshKeyPath)).resolves.toBe('absent');
    });

    it('returns "absent" when the config exists but has no matching Host block', async () => {
      (mockFs.pathExists as unknown as jest.Mock).mockResolvedValue(true);
      (mockFs.readFile as unknown as jest.Mock).mockResolvedValue('Host gitlab.com\n  IdentityFile ~/.ssh/other\n');

      await expect(checkSshConfigHost('github.com', mockSshKeyPath)).resolves.toBe('absent');
    });

    it('returns "match" when the Host block\'s IdentityFile points at the given key', async () => {
      (mockFs.pathExists as unknown as jest.Mock).mockResolvedValue(true);
      (mockFs.readFile as unknown as jest.Mock).mockResolvedValue(
        `Host github.com\n  HostName github.com\n  User git\n  IdentityFile ${mockSshKeyPath}\n  IdentitiesOnly yes\n`
      );

      await expect(checkSshConfigHost('github.com', mockSshKeyPath)).resolves.toBe('match');
    });

    it('returns "points-elsewhere" when the Host block\'s IdentityFile points at a different key', async () => {
      (mockFs.pathExists as unknown as jest.Mock).mockResolvedValue(true);
      (mockFs.readFile as unknown as jest.Mock).mockResolvedValue(
        'Host github.com\n  HostName github.com\n  IdentityFile /mock/home/.ssh/id_other\n'
      );

      await expect(checkSshConfigHost('github.com', mockSshKeyPath)).resolves.toBe('points-elsewhere');
    });

    it('returns "points-elsewhere" when the Host block exists but has no IdentityFile line', async () => {
      (mockFs.pathExists as unknown as jest.Mock).mockResolvedValue(true);
      (mockFs.readFile as unknown as jest.Mock).mockResolvedValue('Host github.com\n  User git\n');

      await expect(checkSshConfigHost('github.com', mockSshKeyPath)).resolves.toBe('points-elsewhere');
    });

    it('strips quotes from a quoted IdentityFile value before comparing', async () => {
      (mockFs.pathExists as unknown as jest.Mock).mockResolvedValue(true);
      (mockFs.readFile as unknown as jest.Mock).mockResolvedValue(
        `Host github.com\n  IdentityFile "${mockSshKeyPath}"\n`
      );

      await expect(checkSshConfigHost('github.com', mockSshKeyPath)).resolves.toBe('match');
    });

    it('ignores a multi-pattern Host block (never a target for the managed check, same as applyHostSSHKey)', async () => {
      (mockFs.pathExists as unknown as jest.Mock).mockResolvedValue(true);
      (mockFs.readFile as unknown as jest.Mock).mockResolvedValue(
        `Host github.com other.example.com\n  IdentityFile ${mockSshKeyPath}\n`
      );

      await expect(checkSshConfigHost('github.com', mockSshKeyPath)).resolves.toBe('absent');
    });
  });
});
