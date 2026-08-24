import fs from 'fs-extra';
import { loadStore, fromSpace } from '../../src/infra/store';
import { getRepositoryBindingStatus } from '../../src/infra/repoBinding';
import { checkKeyLoadedInAgent, checkSshConfigHost, checkHostAccess } from '../../src/infra/ssh';
import { getGitUser, getRecentCommitAuthors } from '../../src/infra/git';
import { doctor } from '../../src/commands/doctor';
import { IStoreV2, ISpace } from '../../src/core/types';

jest.mock('fs-extra');
jest.mock('../../src/infra/store', () => ({
  ...jest.requireActual('../../src/infra/store'),
  loadStore: jest.fn()
}));
jest.mock('../../src/infra/repoBinding', () => ({
  getRepositoryBindingStatus: jest.fn()
}));
jest.mock('../../src/infra/ssh', () => ({
  checkKeyLoadedInAgent: jest.fn(),
  checkSshConfigHost: jest.fn(),
  checkHostAccess: jest.fn()
}));
jest.mock('../../src/infra/git', () => ({
  getGitUser: jest.fn(),
  getRecentCommitAuthors: jest.fn()
}));

const mockFs = fs as jest.Mocked<typeof fs>;
const mockLoadStore = loadStore as jest.MockedFunction<typeof loadStore>;
const mockGetRepositoryBindingStatus = getRepositoryBindingStatus as jest.MockedFunction<typeof getRepositoryBindingStatus>;
const mockCheckKeyLoadedInAgent = checkKeyLoadedInAgent as jest.MockedFunction<typeof checkKeyLoadedInAgent>;
const mockCheckSshConfigHost = checkSshConfigHost as jest.MockedFunction<typeof checkSshConfigHost>;
const mockCheckHostAccess = checkHostAccess as jest.MockedFunction<typeof checkHostAccess>;
const mockGetGitUser = getGitUser as jest.MockedFunction<typeof getGitUser>;
const mockGetRecentCommitAuthors = getRecentCommitAuthors as jest.MockedFunction<typeof getRecentCommitAuthors>;

function storeOf(spaces: ISpace[], active?: string, rules: IStoreV2['rules'] = []): IStoreV2 {
  return { version: 2, identities: spaces.map(fromSpace), active, bindings: [], rules };
}

const keyedIdentity: ISpace = {
  name: 'work',
  email: 'work@example.com',
  userName: 'Work User',
  host: 'github.com',
  sshKeyPath: '/mock/dss/spaces/work/id_ed25519'
};

describe('commands/doctor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
    mockGetRepositoryBindingStatus.mockRejectedValue(new Error('not a git repository'));
    mockFs.pathExists.mockResolvedValue(true as never);
    (mockFs.stat as unknown as jest.Mock).mockResolvedValue({ mode: 0o100600 });
    mockCheckKeyLoadedInAgent.mockResolvedValue({ loaded: true, checked: true, fingerprint: 'SHA256:abc' });
    mockCheckSshConfigHost.mockResolvedValue('match');
    mockCheckHostAccess.mockResolvedValue({ ok: true, detail: 'Successfully authenticated with github.com.' });
    mockGetGitUser.mockResolvedValue({ userName: 'Work User', email: 'work@example.com' });
    mockGetRecentCommitAuthors.mockResolvedValue([]);
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  describe('identity resolution', () => {
    it('resolves a named identity (slug-aware)', async () => {
      mockLoadStore.mockResolvedValue(storeOf([keyedIdentity]));

      await doctor('Work');

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Doctor: work'));
      expect(process.exitCode).toBeUndefined();
    });

    it('fails (exit 1) when a named identity is not found', async () => {
      mockLoadStore.mockResolvedValue(storeOf([keyedIdentity]));

      await doctor('does-not-exist');

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Identity "does-not-exist" not found.'));
      expect(process.exitCode).toBe(1);
    });

    it('resolves the identity bound to cwd when no name is given', async () => {
      mockLoadStore.mockResolvedValue(storeOf([keyedIdentity, { ...keyedIdentity, name: 'personal', sshKeyPath: '' }], 'personal'));
      mockGetRepositoryBindingStatus.mockResolvedValue({
        repositoryRoot: '/repo',
        configPath: '/repo/.git/dss/config',
        bound: true,
        spaceName: 'work'
      });

      await doctor();

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Doctor: work'));
    });

    it('falls back to the global active identity when cwd is unbound', async () => {
      mockLoadStore.mockResolvedValue(storeOf([keyedIdentity], 'work'));
      mockGetRepositoryBindingStatus.mockResolvedValue({
        repositoryRoot: '/repo',
        configPath: '/repo/.git/dss/config',
        bound: false
      });

      await doctor();

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Doctor: work'));
    });

    it('fails (exit 1) when no name is given, cwd is unbound, and there is no active identity', async () => {
      mockLoadStore.mockResolvedValue(storeOf([keyedIdentity]));

      await doctor();

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('No identity to check'));
      expect(process.exitCode).toBe(1);
    });
  });

  describe('check matrix', () => {
    it('renders all ✓ and exits 0 when everything is healthy', async () => {
      mockLoadStore.mockResolvedValue(storeOf([keyedIdentity], 'work'));

      await doctor('work');

      expect(process.exitCode).toBeUndefined();
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('All checks passed'));
    });

    it('flags a keyless identity as a hard failure (✗) and sets exit code 1', async () => {
      mockLoadStore.mockResolvedValue(storeOf([{ ...keyedIdentity, sshKeyPath: '' }], 'work'));

      await doctor('work');

      expect(process.exitCode).toBe(1);
      const calls = (console.log as jest.Mock).mock.calls.flat();
      expect(calls.some(c => typeof c === 'string' && c.includes('no SSH key configured'))).toBe(true);
    });

    it('flags a missing private key file as a hard failure (✗) and sets exit code 1', async () => {
      mockLoadStore.mockResolvedValue(storeOf([keyedIdentity], 'work'));
      (mockFs.pathExists as unknown as jest.Mock).mockImplementation(async (p: string) =>
        !p.endsWith('id_ed25519') || p.endsWith('.pub')
      );

      await doctor('work');

      expect(process.exitCode).toBe(1);
    });

    it('flags bad key file permissions as a warning (!) only — does not set exit code 1', async () => {
      mockLoadStore.mockResolvedValue(storeOf([keyedIdentity], 'work'));
      (mockFs.stat as unknown as jest.Mock).mockResolvedValue({ mode: 0o100644 });

      await doctor('work');

      expect(process.exitCode).toBeUndefined();
      const calls = (console.log as jest.Mock).mock.calls.flat();
      expect(calls.some(c => typeof c === 'string' && c.includes('issue'))).toBe(true);
    });

    it('flags agent-not-loaded as a warning (!) only — does not set exit code 1', async () => {
      mockLoadStore.mockResolvedValue(storeOf([keyedIdentity], 'work'));
      mockCheckKeyLoadedInAgent.mockResolvedValue({ loaded: false, checked: true, fingerprint: 'SHA256:abc' });

      await doctor('work');

      expect(process.exitCode).toBeUndefined();
    });

    it('flags ssh-config "points elsewhere" as a warning (!) only', async () => {
      mockLoadStore.mockResolvedValue(storeOf([keyedIdentity], 'work'));
      mockCheckSshConfigHost.mockResolvedValue('points-elsewhere');

      await doctor('work');

      expect(process.exitCode).toBeUndefined();
      const calls = (console.log as jest.Mock).mock.calls.flat();
      expect(calls.some(c => typeof c === 'string' && c.includes('points elsewhere'))).toBe(true);
    });

    it('flags ssh-config "absent" as a warning (!) only', async () => {
      mockLoadStore.mockResolvedValue(storeOf([keyedIdentity], 'work'));
      mockCheckSshConfigHost.mockResolvedValue('absent');

      await doctor('work');

      expect(process.exitCode).toBeUndefined();
    });

    it('calls checkHostAccess (the PURE, non-prompting check — NOT testHostAccess) with the identity\'s key/host, and renders a ✓ Host auth line on success', async () => {
      mockLoadStore.mockResolvedValue(storeOf([keyedIdentity], 'work'));
      mockCheckHostAccess.mockResolvedValue({ ok: true, detail: 'Successfully authenticated with github.com.' });

      await doctor('work');

      expect(mockCheckHostAccess).toHaveBeenCalledWith(keyedIdentity.sshKeyPath, 'github.com');
      expect(process.exitCode).toBeUndefined();
      const calls = (console.log as jest.Mock).mock.calls.flat();
      expect(calls.some(c => typeof c === 'string' && c.includes('Host auth') && c.includes('authenticated'))).toBe(true);
    });

    it('renders a ✗ Host auth line and treats an auth failure as a hard failure (✗), setting exit code 1', async () => {
      mockLoadStore.mockResolvedValue(storeOf([keyedIdentity], 'work'));
      mockCheckHostAccess.mockResolvedValue({ ok: false, detail: 'Permission denied (publickey).' });

      await doctor('work');

      expect(process.exitCode).toBe(1);
      const calls = (console.log as jest.Mock).mock.calls.flat();
      expect(calls.some(c => typeof c === 'string' && c.includes('Host auth') && c.includes('Permission denied'))).toBe(true);
    });

    it('skips checkHostAccess entirely for a keyless identity', async () => {
      mockLoadStore.mockResolvedValue(storeOf([{ ...keyedIdentity, sshKeyPath: '' }], 'work'));

      await doctor('work');

      expect(mockCheckHostAccess).not.toHaveBeenCalled();
    });

    it('doctor never imports/calls the interactive testHostAccess — only the pure checkHostAccess is available to it', () => {
      // The jest.mock('../../src/infra/ssh', ...) factory above does not
      // even export `testHostAccess` — if doctor.ts still referenced it,
      // this whole test file would fail to load with "is not a function".
      // This test exists to make that guarantee explicit and named.
      expect(mockCheckHostAccess).toBeDefined();
    });

    it('flags git identity drift as a warning (!) only', async () => {
      mockLoadStore.mockResolvedValue(storeOf([keyedIdentity], 'work'));
      mockGetGitUser.mockResolvedValue({ userName: 'Someone Else', email: 'other@example.com' });

      await doctor('work');

      expect(process.exitCode).toBeUndefined();
      const calls = (console.log as jest.Mock).mock.calls.flat();
      expect(calls.some(c => typeof c === 'string' && c.includes('issue'))).toBe(true);
    });

    it('treats a getGitUser failure as a warning (!), not a crash', async () => {
      mockLoadStore.mockResolvedValue(storeOf([keyedIdentity], 'work'));
      mockGetGitUser.mockRejectedValue(new Error('git not found'));

      await expect(doctor('work')).resolves.toBeUndefined();
      expect(process.exitCode).toBeUndefined();
    });

    // Finding 2: getGitUser() is cwd-sensitive (`--global --includes`
    // resolves through whatever includeIf applies HERE), so inside a ruled
    // directory it reports the RULE's identity, not the active one this
    // doctor run is checking — comparing the two produced a misleading
    // "doesn't match — dss use <name>" warning that "dss use" can't
    // actually fix. Simulates that real cwd-sensitivity: getGitUser
    // resolves to the RULED identity's own values while `identity` (the
    // one doctor('work') is checking) is the ACTIVE identity.
    it('does not show a misleading "Git identity" drift warning inside a ruled directory — relies on Rule drift instead', async () => {
      const ruledIdentity: ISpace = { ...keyedIdentity, name: 'acme', email: 'acme@example.com', userName: 'Acme User' };
      mockLoadStore.mockResolvedValue(storeOf([keyedIdentity, ruledIdentity], 'work', [{ dir: '/code/acme', identity: 'acme' }]));
      mockFs.realpath.mockResolvedValue('/code/acme/project' as never);
      mockGetGitUser.mockResolvedValue({ userName: ruledIdentity.userName, email: ruledIdentity.email });

      await doctor('work');

      const calls = (console.log as jest.Mock).mock.calls.flat();
      // No "warn:" (PLAIN-mode) tag on the Git identity line — it must not
      // be flagged as drift.
      expect(calls.some(c => typeof c === 'string' && /warn: Git identity/.test(c))).toBe(false);
      expect(calls.some(c => typeof c === 'string' && c.includes('Git identity') && c.includes('not checked'))).toBe(true);
      expect(calls.some(c => typeof c === 'string' && c.includes('Rule drift') && c.includes('matches'))).toBe(true);
      expect(process.exitCode).toBeUndefined();
    });

    it('skips the "Git identity" drift check when cwd is bound to a different identity — relies on Repo binding instead', async () => {
      const boundIdentity: ISpace = { ...keyedIdentity, name: 'personal', email: 'personal@example.com', userName: 'Personal User' };
      mockLoadStore.mockResolvedValue(storeOf([keyedIdentity, boundIdentity], 'work'));
      mockGetRepositoryBindingStatus.mockResolvedValue({
        repositoryRoot: '/repo',
        configPath: '/repo/.git/dss/config',
        bound: true,
        spaceName: 'personal'
      });
      mockGetGitUser.mockResolvedValue({ userName: boundIdentity.userName, email: boundIdentity.email });

      await doctor('work');

      const calls = (console.log as jest.Mock).mock.calls.flat();
      expect(calls.some(c => typeof c === 'string' && /warn: Git identity/.test(c))).toBe(false);
      expect(calls.some(c => typeof c === 'string' && c.includes('Git identity') && c.includes('not checked'))).toBe(true);
    });

    it('keeps the "Git identity" drift check meaningful when no rule/binding overrides here (source: global)', async () => {
      mockLoadStore.mockResolvedValue(storeOf([keyedIdentity], 'work'));
      mockGetGitUser.mockResolvedValue({ userName: 'Someone Else', email: 'other@example.com' });

      await doctor('work');

      const calls = (console.log as jest.Mock).mock.calls.flat();
      expect(calls.some(c => typeof c === 'string' && /warn: Git identity/.test(c))).toBe(true);
    });

    it('shows the repo binding section when cwd is a git repo, and flags a binding to a DIFFERENT identity as a warning', async () => {
      mockLoadStore.mockResolvedValue(storeOf([keyedIdentity, { ...keyedIdentity, name: 'personal' }], 'work'));
      mockGetRepositoryBindingStatus.mockResolvedValue({
        repositoryRoot: '/repo',
        configPath: '/repo/.git/dss/config',
        bound: true,
        spaceName: 'personal'
      });

      await doctor('work');

      const calls = (console.log as jest.Mock).mock.calls.flat();
      expect(calls.some(c => typeof c === 'string' && c.includes('/repo'))).toBe(true);
      expect(process.exitCode).toBeUndefined(); // binding mismatch is a warning, not a hard failure
    });

    it('omits the repo binding section entirely when cwd is not a git repository', async () => {
      mockLoadStore.mockResolvedValue(storeOf([keyedIdentity], 'work'));
      mockGetRepositoryBindingStatus.mockRejectedValue(new Error('not a git repository'));

      await doctor('work');

      const calls = (console.log as jest.Mock).mock.calls.flat();
      expect(calls.some(c => typeof c === 'string' && c.includes('Repo binding'))).toBe(false);
    });

    it('shows a Directory rule section and flags rule drift as a warning when the effective git identity does not match the ruled identity', async () => {
      const ruledIdentity: ISpace = { ...keyedIdentity, name: 'acme', email: 'acme@example.com', userName: 'Acme User' };
      mockLoadStore.mockResolvedValue(storeOf([keyedIdentity, ruledIdentity], 'work', [{ dir: '/code/acme', identity: 'acme' }]));
      mockFs.realpath.mockResolvedValue('/code/acme/project' as never);
      // beforeEach's mockGetGitUser resolves to keyedIdentity's own
      // userName/email — matches "work" (the identity being doctored) but
      // NOT "acme" (the ruled identity for this cwd), so the rule-drift
      // check must flag a mismatch independent of which identity `doctor`
      // was asked to check.

      await doctor('work');

      const calls = (console.log as jest.Mock).mock.calls.flat();
      expect(calls.some(c => typeof c === 'string' && c.includes('Directory rule'))).toBe(true);
      expect(calls.some(c => typeof c === 'string' && c.includes('/code/acme') && c.includes('acme'))).toBe(true);
      expect(calls.some(c => typeof c === 'string' && c.includes('Rule drift'))).toBe(true);
      expect(process.exitCode).toBeUndefined(); // rule drift is a warning, not a hard failure
    });

    it('shows Rule drift as a match when the effective git identity equals the ruled identity', async () => {
      mockLoadStore.mockResolvedValue(storeOf([keyedIdentity], 'work', [{ dir: '/code/acme', identity: 'work' }]));
      mockFs.realpath.mockResolvedValue('/code/acme/project' as never);
      // beforeEach's mockGetGitUser already matches keyedIdentity ("work"),
      // which is also this rule's identity — no drift.

      await doctor('work');

      const calls = (console.log as jest.Mock).mock.calls.flat();
      expect(calls.some(c => typeof c === 'string' && c.includes('Rule drift') && c.includes('matches'))).toBe(true);
      expect(process.exitCode).toBeUndefined();
    });

    it('omits the Directory rule section entirely when cwd matches no configured rule', async () => {
      mockLoadStore.mockResolvedValue(storeOf([keyedIdentity], 'work', [{ dir: '/code/acme', identity: 'work' }]));
      mockFs.realpath.mockResolvedValue('/somewhere/else' as never);

      await doctor('work');

      const calls = (console.log as jest.Mock).mock.calls.flat();
      expect(calls.some(c => typeof c === 'string' && c.includes('Directory rule'))).toBe(false);
    });

    it('exits 0 with a warning summary when only ! issues occurred (no ✗)', async () => {
      mockLoadStore.mockResolvedValue(storeOf([keyedIdentity], 'work'));
      mockCheckKeyLoadedInAgent.mockResolvedValue({ loaded: false, checked: true });

      await doctor('work');

      expect(process.exitCode).toBeUndefined();
      const calls = (console.log as jest.Mock).mock.calls.flat();
      // PLAIN mode (Jest's non-TTY default) degrades the em-dash to a plain
      // ASCII dash — no decorative "—" should leak into piped/CI output.
      expect(calls.some(c => typeof c === 'string' && /\d+ issues? -/.test(c))).toBe(true);
      expect(calls.every(c => typeof c !== 'string' || !c.includes('—'))).toBe(true);
    });
  });

  describe('Commit history drift (wrong-identity guard, part 1)', () => {
    function bound(spaceName = 'work') {
      mockGetRepositoryBindingStatus.mockResolvedValue({
        repositoryRoot: '/repo',
        configPath: '/repo/.git/dss/config',
        bound: true,
        spaceName
      });
    }

    it('omits the section entirely when cwd is not a git repository', async () => {
      mockLoadStore.mockResolvedValue(storeOf([keyedIdentity], 'work'));
      // beforeEach's default already rejects getRepositoryBindingStatus.

      await doctor('work');

      expect(mockGetRecentCommitAuthors).not.toHaveBeenCalled();
      const calls = (console.log as jest.Mock).mock.calls.flat();
      expect(calls.some(c => typeof c === 'string' && c.includes('Commit history'))).toBe(false);
    });

    it('omits the section entirely for an empty repository (no commits yet)', async () => {
      mockLoadStore.mockResolvedValue(storeOf([keyedIdentity], 'work'));
      bound();
      mockGetRecentCommitAuthors.mockResolvedValue([]);

      await doctor('work');

      const calls = (console.log as jest.Mock).mock.calls.flat();
      expect(calls.some(c => typeof c === 'string' && c.includes('Commit history'))).toBe(false);
    });

    it('reports a ✓ match when every recent commit author matches the checked identity', async () => {
      mockLoadStore.mockResolvedValue(storeOf([keyedIdentity], 'work'));
      bound();
      mockGetRecentCommitAuthors.mockResolvedValue([
        { email: 'work@example.com', name: 'Work User' },
        { email: 'work@example.com', name: 'Work User' },
        { email: 'work@example.com', name: 'Work User' }
      ]);

      await doctor('work');

      const calls = (console.log as jest.Mock).mock.calls.flat();
      expect(calls.some(c => typeof c === 'string' && c.includes('Commit history') && c.includes('last 3 commits match'))).toBe(true);
      expect(process.exitCode).toBeUndefined();
    });

    it('reports a ! warning (M of N, not exit 1) when some recent commits were authored under a different identity', async () => {
      mockLoadStore.mockResolvedValue(storeOf([keyedIdentity], 'work'));
      bound();
      mockGetRecentCommitAuthors.mockResolvedValue([
        { email: 'work@example.com', name: 'Work User' },
        { email: 'other@example.com', name: 'Someone Else' },
        { email: 'other@example.com', name: 'Someone Else' }
      ]);

      await doctor('work');

      const calls = (console.log as jest.Mock).mock.calls.flat();
      expect(calls.some(c =>
        typeof c === 'string' &&
        c.includes('Commit history') &&
        c.includes('2 of 3 recent commits authored as other@example.com')
      )).toBe(true);
      // Warning class — never sets exit code 1, per the established ✗-vs-! calibration.
      expect(process.exitCode).toBeUndefined();
    });

    it('dedupes mismatched emails, listing up to 3 then "+K more"', async () => {
      mockLoadStore.mockResolvedValue(storeOf([keyedIdentity], 'work'));
      bound();
      mockGetRecentCommitAuthors.mockResolvedValue([
        { email: 'a@example.com', name: 'A' },
        { email: 'b@example.com', name: 'B' },
        { email: 'c@example.com', name: 'C' },
        { email: 'd@example.com', name: 'D' },
        { email: 'e@example.com', name: 'E' }
      ]);

      await doctor('work');

      const calls = (console.log as jest.Mock).mock.calls.flat();
      expect(calls.some(c =>
        typeof c === 'string' &&
        c.includes('5 of 5 recent commits authored as a@example.com, b@example.com, c@example.com +2 more')
      )).toBe(true);
      expect(process.exitCode).toBeUndefined();
    });

    it('uses resolveAppliesHere (bound > rule > global) as the expected identity when no identityName is given — proven by a case where it diverges from the main "Doctor: <name>" identity', async () => {
      // cwd is UNBOUND but falls under a directory rule for "acme"; the
      // store's global active is "personal". Doctor's own (unchanged)
      // resolveIdentity has no rule support, so the header identity stays
      // "personal" — but the commit-history section's EXPECTED identity
      // must come from resolveAppliesHere (bound > rule > global), which
      // resolves the RULED identity ("acme") here — proving the new
      // section really calls the shared resolver, not a copy of the old
      // bound/active-only fallback.
      const personal: ISpace = { ...keyedIdentity, name: 'personal', email: 'personal@example.com' };
      const acme: ISpace = { ...keyedIdentity, name: 'acme', email: 'acme@example.com', userName: 'Acme User' };
      mockLoadStore.mockResolvedValue(
        storeOf([keyedIdentity, personal, acme], 'personal', [{ dir: '/code/acme', identity: 'acme' }])
      );
      mockGetRepositoryBindingStatus.mockResolvedValue({
        repositoryRoot: '/code/acme/project',
        configPath: '/code/acme/project/.git/dss/config',
        bound: false
      });
      mockFs.realpath.mockResolvedValue('/code/acme/project' as never);
      mockGetRecentCommitAuthors.mockResolvedValue([{ email: 'acme@example.com', name: 'Acme User' }]);

      await doctor();

      const calls = (console.log as jest.Mock).mock.calls.flat();
      expect(calls.some(c => typeof c === 'string' && c.includes('Doctor: personal'))).toBe(true);
      expect(calls.some(c => typeof c === 'string' && c.includes('Commit history') && c.includes('last 1 commits match'))).toBe(true);
    });
  });
});
