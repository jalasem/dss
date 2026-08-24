import path from 'path';
import fs from 'fs-extra';
import { select } from '@inquirer/prompts';
import { cloneRepository } from '../../src/commands/clone';
import { UsageError } from '../../src/commands/prompts';
import { UIHelper } from '../../src/commands/ui';
import { loadStore, fromSpace } from '../../src/infra/store';
import { canonicalizeRuleDir } from '../../src/infra/rules';
import { bindRepository, buildSshCommand } from '../../src/infra/repoBinding';
import { runGitClone, GitCloneError } from '../../src/infra/gitClone';
import { updateBindingRegistry } from '../../src/commands/binding';
import { IStoreV2, ISpace, IRule } from '../../src/core/types';

// Matches the rest of this codebase's convention (see doctor.test.ts,
// spaces.test.ts): command-level unit tests assert on business logic —
// which identity/reason/env was selected, which infra calls were made —
// via mocked collaborators and console output, not by poking at
// jsonOutput.ts's module-level state. The `--json` payload's exact shape is
// covered end-to-end by tests/docsDriftPayloads.test.ts (spawned CLI).

jest.mock('fs-extra');
jest.mock('@inquirer/prompts', () => ({
  select: jest.fn(),
}));
jest.mock('../../src/infra/store', () => ({
  ...jest.requireActual('../../src/infra/store'),
  loadStore: jest.fn(),
}));
jest.mock('../../src/infra/rules', () => ({
  canonicalizeRuleDir: jest.fn(),
}));
jest.mock('../../src/infra/repoBinding', () => ({
  ...jest.requireActual('../../src/infra/repoBinding'),
  bindRepository: jest.fn(),
}));
jest.mock('../../src/infra/gitClone', () => ({
  ...jest.requireActual('../../src/infra/gitClone'),
  runGitClone: jest.fn(),
}));
jest.mock('../../src/commands/binding', () => ({
  updateBindingRegistry: jest.fn(async (update: (store: unknown) => void) => update({})),
}));

const mockFs = fs as jest.Mocked<typeof fs>;
const mockSelect = select as jest.MockedFunction<typeof select>;
const mockLoadStore = loadStore as jest.MockedFunction<typeof loadStore>;
const mockCanonicalizeRuleDir = canonicalizeRuleDir as jest.MockedFunction<typeof canonicalizeRuleDir>;
const mockBindRepository = bindRepository as jest.MockedFunction<typeof bindRepository>;
const mockRunGitClone = runGitClone as jest.MockedFunction<typeof runGitClone>;
const mockUpdateBindingRegistry = updateBindingRegistry as jest.MockedFunction<typeof updateBindingRegistry>;

function storeOf(spaces: ISpace[], rules: IRule[] = []): IStoreV2 {
  return { version: 2, identities: spaces.map(fromSpace), bindings: [], rules };
}

const work: ISpace = {
  name: 'work',
  email: 'work@example.com',
  userName: 'Work User',
  host: 'github.com',
  sshKeyPath: '/mock/dss/spaces/work/id_ed25519'
};

const personal: ISpace = {
  name: 'personal',
  email: 'personal@example.com',
  userName: 'Personal User',
  host: 'github.com',
  sshKeyPath: '/mock/dss/spaces/personal/id_ed25519'
};

const keyless: ISpace = {
  name: 'noKey',
  email: 'nokey@example.com',
  userName: 'No Key',
  host: 'gitlab.com',
  sshKeyPath: ''
};

const otherHost: ISpace = {
  name: 'otherHost',
  email: 'other@example.com',
  userName: 'Other Host',
  host: 'bitbucket.org',
  sshKeyPath: '/mock/dss/spaces/otherHost/id_ed25519'
};

/** Name of the identity `dss clone` actually cloned+bound with — read off
 * the space handed to bindRepository, the same object toSpace(identity)
 * produces from the selected identity. */
function boundIdentityName(): string | undefined {
  return mockBindRepository.mock.calls[0]?.[1]?.name;
}

function loggedLines(): string {
  return (console.log as jest.Mock).mock.calls.map(call => call.join(' ')).join('\n');
}

describe('commands/clone — dss clone', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
    mockFs.pathExists.mockResolvedValue(false as never);
    mockCanonicalizeRuleDir.mockImplementation(async (dir: string) => path.resolve(dir));
    mockBindRepository.mockResolvedValue({
      repositoryRoot: '/resolved/dest',
      configPath: '/resolved/dest/.git/dss/config',
      bound: true,
      spaceName: 'work'
    });
    mockRunGitClone.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  describe('URL parsing', () => {
    it('throws a UsageError (exit 2) for an unrecognized URL', async () => {
      mockLoadStore.mockResolvedValue(storeOf([work]));

      await expect(cloneRepository('nonsense', undefined, {})).rejects.toBeInstanceOf(UsageError);
    });
  });

  describe('destination handling', () => {
    it('fails (exit 1) when the destination already exists', async () => {
      mockLoadStore.mockResolvedValue(storeOf([work]));
      mockFs.pathExists.mockResolvedValue(true as never);

      await cloneRepository('https://github.com/acme/api.git', undefined, {});

      expect(process.exitCode).toBe(1);
      expect(mockRunGitClone).not.toHaveBeenCalled();
    });

    it('defaults the destination to ./<repoName> under cwd', async () => {
      mockLoadStore.mockResolvedValue(storeOf([work]));

      await cloneRepository('https://github.com/acme/api.git', undefined, { identity: 'work' });

      const expectedDest = path.resolve(process.cwd(), 'api');
      expect(mockRunGitClone).toHaveBeenCalledWith('https://github.com/acme/api.git', expectedDest, expect.anything());
    });
  });

  describe('identity selection order', () => {
    it('step 1: --identity flag wins over a matching rule and a matching host', async () => {
      const ruleDir = path.resolve(process.cwd(), 'api');
      mockLoadStore.mockResolvedValue(storeOf([work, personal], [{ dir: ruleDir, identity: 'personal' }]));

      await cloneRepository('https://github.com/acme/api.git', undefined, { identity: 'work' });

      expect(process.exitCode).toBeUndefined();
      expect(boundIdentityName()).toBe('work');
      expect(loggedLines()).toContain('(flag)');
    });

    it('fails (exit 1) when --identity names an identity that does not exist', async () => {
      mockLoadStore.mockResolvedValue(storeOf([work]));

      await cloneRepository('https://github.com/acme/api.git', undefined, { identity: 'ghost' });

      expect(process.exitCode).toBe(1);
      expect(mockRunGitClone).not.toHaveBeenCalled();
    });

    it('step 2: a directory rule matching the destination beats a host match', async () => {
      const ruleDir = path.resolve(process.cwd(), 'api');
      mockLoadStore.mockResolvedValue(storeOf([work, personal], [{ dir: ruleDir, identity: 'personal' }]));

      await cloneRepository('https://github.com/acme/api.git', undefined, {});

      expect(boundIdentityName()).toBe('personal');
      expect(loggedLines()).toContain('(rule)');
    });

    it('step 3: exactly one identity matching the URL host is auto-picked', async () => {
      mockLoadStore.mockResolvedValue(storeOf([work, keyless]));

      await cloneRepository('https://github.com/acme/api.git', undefined, {});

      expect(boundIdentityName()).toBe('work');
      expect(loggedLines()).toContain('(host)');
      expect(mockSelect).not.toHaveBeenCalled();
    });

    it('step 3: several identities matching the host prompt interactively (reason "selected")', async () => {
      mockLoadStore.mockResolvedValue(storeOf([work, personal]));
      mockSelect.mockResolvedValue('personal');

      await cloneRepository('https://github.com/acme/api.git', undefined, {});

      expect(mockSelect).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining('github.com')
      }));
      expect(boundIdentityName()).toBe('personal');
      expect(loggedLines()).toContain('(selected)');
    });

    it('step 3: several host matches, non-interactive -> UsageError exit 2 naming --identity', async () => {
      mockLoadStore.mockResolvedValue(storeOf([work, personal]));
      process.env.DSS_NO_INPUT = '1';

      await expect(cloneRepository('https://github.com/acme/api.git', undefined, {})).rejects.toMatchObject({
        exitCode: 2,
        message: expect.stringContaining('--identity')
      });
      expect(mockRunGitClone).not.toHaveBeenCalled();
    });

    it('step 4: zero host matches falls through to an interactive pick among ALL identities', async () => {
      // URL host (github.com) matches nobody here (gitlab.com/bitbucket.org
      // only) — zero host matches, so step 4's ALL-identity prompt is used.
      mockLoadStore.mockResolvedValue(storeOf([keyless, otherHost]));
      mockSelect.mockResolvedValue('otherHost');

      await cloneRepository('https://github.com/acme/api.git', undefined, {});

      expect(boundIdentityName()).toBe('otherHost');
      expect(loggedLines()).toContain('(selected)');
    });

    it('step 4: no host in the URL (local path) skips host-match and goes straight to the ALL-identity prompt', async () => {
      mockLoadStore.mockResolvedValue(storeOf([work, personal]));
      mockSelect.mockResolvedValue('work');

      await cloneRepository('/tmp/fixtures/source.git', '/tmp/dest', {});

      expect(mockSelect).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining('Choose an identity')
      }));
      expect(boundIdentityName()).toBe('work');
      expect(loggedLines()).toContain('(selected)');
    });

    it('step 4: non-interactive with no usable flag/rule/host match -> UsageError exit 2 naming --identity', async () => {
      mockLoadStore.mockResolvedValue(storeOf([work, personal]));
      process.env.DSS_NO_INPUT = '1';

      await expect(cloneRepository('/tmp/fixtures/source.git', '/tmp/dest', {})).rejects.toMatchObject({
        exitCode: 2,
        message: expect.stringContaining('--identity')
      });
      expect(mockRunGitClone).not.toHaveBeenCalled();
    });

    it('fails (exit 1) when no identities are configured at all', async () => {
      mockLoadStore.mockResolvedValue(storeOf([]));

      await cloneRepository('/tmp/fixtures/source.git', '/tmp/dest', {});

      expect(process.exitCode).toBe(1);
      expect(mockRunGitClone).not.toHaveBeenCalled();
    });
  });

  describe('GIT_SSH_COMMAND / keyless-identity warning', () => {
    it('a keyed identity + ssh-style URL clones with GIT_SSH_COMMAND set', async () => {
      mockLoadStore.mockResolvedValue(storeOf([work]));

      await cloneRepository('git@github.com:acme/api.git', undefined, { identity: 'work' });

      const options = mockRunGitClone.mock.calls[0][2];
      expect(options.env?.GIT_SSH_COMMAND).toBe(buildSshCommand(work.sshKeyPath));
    });

    it('an https URL never gets GIT_SSH_COMMAND, even for a keyed identity', async () => {
      mockLoadStore.mockResolvedValue(storeOf([work]));

      await cloneRepository('https://github.com/acme/api.git', undefined, { identity: 'work' });

      const options = mockRunGitClone.mock.calls[0][2];
      expect(options.env).toBeUndefined();
    });

    it('a local path URL never gets GIT_SSH_COMMAND', async () => {
      mockLoadStore.mockResolvedValue(storeOf([work]));

      await cloneRepository('/tmp/fixtures/source.git', '/tmp/dest', { identity: 'work' });

      const options = mockRunGitClone.mock.calls[0][2];
      expect(options.env).toBeUndefined();
    });

    it('a keyless identity + ssh-style URL warns and proceeds without GIT_SSH_COMMAND', async () => {
      mockLoadStore.mockResolvedValue(storeOf([keyless]));
      const warningSpy = jest.spyOn(UIHelper, 'warning');

      await cloneRepository('git@gitlab.com:acme/api.git', undefined, { identity: 'noKey' });

      expect(warningSpy).toHaveBeenCalledWith(expect.stringContaining('has no SSH key'));
      const options = mockRunGitClone.mock.calls[0][2];
      expect(options.env).toBeUndefined();
      expect(process.exitCode).toBeUndefined();
    });
  });

  describe('clone + bind', () => {
    it('a successful clone binds the repo to the selected identity and updates the registry', async () => {
      mockLoadStore.mockResolvedValue(storeOf([work]));

      await cloneRepository('https://github.com/acme/api.git', undefined, { identity: 'work' });

      expect(process.exitCode).toBeUndefined();
      expect(mockBindRepository).toHaveBeenCalledWith(
        path.resolve(process.cwd(), 'api'),
        expect.objectContaining({ name: 'work' }),
        {}
      );
      expect(mockUpdateBindingRegistry).toHaveBeenCalled();
      expect(loggedLines()).toContain('bound to work');
    });

    it('a bind failure after a successful clone warns, keeps exit 0, and does not update the registry', async () => {
      mockLoadStore.mockResolvedValue(storeOf([work]));
      mockBindRepository.mockRejectedValue(new Error('git version too old'));
      const warningSpy = jest.spyOn(UIHelper, 'warning');

      await cloneRepository('https://github.com/acme/api.git', undefined, { identity: 'work' });

      expect(process.exitCode).toBeUndefined();
      expect(warningSpy).toHaveBeenCalledWith(expect.stringContaining('could not bind'));
      expect(mockUpdateBindingRegistry).not.toHaveBeenCalled();
      expect(loggedLines()).toContain('not bound');
    });

    it('a git clone failure fails (exit 1) with the GitCloneError message and never attempts to bind', async () => {
      mockLoadStore.mockResolvedValue(storeOf([work]));
      mockRunGitClone.mockRejectedValue(new GitCloneError('git clone failed: fatal: repository not found', 'fatal: repository not found'));

      await cloneRepository('https://github.com/acme/api.git', undefined, { identity: 'work' });

      expect(process.exitCode).toBe(1);
      expect(mockBindRepository).not.toHaveBeenCalled();
      expect(loggedLines()).toContain('repository not found');
    });
  });
});
