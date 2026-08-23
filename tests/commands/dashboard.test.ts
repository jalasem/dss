import fs from 'fs-extra';
import { execFile } from 'child_process';
import { loadStore, fromSpace } from '../../src/infra/store';
import { getRepositoryBindingStatus } from '../../src/infra/repoBinding';
import { checkKeyLoadedInAgent, testHostAccess } from '../../src/infra/ssh';
import { firstRunFlow } from '../../src/commands/firstRun';
import { dashboard } from '../../src/commands/dashboard';
import { IStoreV2, ISpace } from '../../src/core/types';

jest.mock('fs-extra');
jest.mock('child_process');
jest.mock('../../src/infra/store', () => ({
  ...jest.requireActual('../../src/infra/store'),
  loadStore: jest.fn()
}));
jest.mock('../../src/infra/repoBinding', () => ({
  getRepositoryBindingStatus: jest.fn()
}));
jest.mock('../../src/infra/ssh', () => ({
  checkKeyLoadedInAgent: jest.fn(),
  testHostAccess: jest.fn()
}));
jest.mock('../../src/commands/firstRun', () => ({
  firstRunFlow: jest.fn()
}));

const mockFs = fs as jest.Mocked<typeof fs>;
const mockExecFile = execFile as unknown as jest.MockedFunction<typeof execFile>;
const mockLoadStore = loadStore as jest.MockedFunction<typeof loadStore>;
const mockGetRepositoryBindingStatus = getRepositoryBindingStatus as jest.MockedFunction<typeof getRepositoryBindingStatus>;
const mockCheckKeyLoadedInAgent = checkKeyLoadedInAgent as jest.MockedFunction<typeof checkKeyLoadedInAgent>;
const mockTestHostAccess = testHostAccess as jest.MockedFunction<typeof testHostAccess>;
const mockFirstRunFlow = firstRunFlow as jest.MockedFunction<typeof firstRunFlow>;

function storeOf(spaces: ISpace[], active?: string): IStoreV2 {
  return { version: 2, identities: spaces.map(fromSpace), active, bindings: [] };
}

function loggedLines(): string[] {
  return (console.log as jest.Mock).mock.calls.flat().filter((v): v is string => typeof v === 'string');
}

describe('commands/dashboard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
    mockFs.pathExists.mockResolvedValue(true as never);
    mockCheckKeyLoadedInAgent.mockResolvedValue({ loaded: true, checked: true, fingerprint: 'SHA256:abc' });
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it('calls firstRunFlow (and does nothing else) when the store has zero identities', async () => {
    mockLoadStore.mockResolvedValue(storeOf([]));
    mockFirstRunFlow.mockResolvedValue(true);

    await dashboard();

    expect(mockFirstRunFlow).toHaveBeenCalledWith({ spaces: [], activeSpace: undefined });
    expect(mockGetRepositoryBindingStatus).not.toHaveBeenCalled();
  });

  it('shows the bound identity and "bound to this repo" when cwd is bound', async () => {
    const store = storeOf(
      [
        { name: 'work', email: 'work@example.com', userName: 'Work', sshKeyPath: '/mock/work/id_ed25519' },
        { name: 'personal', email: 'personal@example.com', userName: 'Personal', sshKeyPath: '' }
      ],
      'personal'
    );
    mockLoadStore.mockResolvedValue(store);
    mockGetRepositoryBindingStatus.mockResolvedValue({
      repositoryRoot: '/repo',
      configPath: '/repo/.git/dss/config',
      bound: true,
      spaceName: 'work'
    });

    await dashboard();

    const lines = loggedLines();
    expect(lines.some(l => l.includes('work') && l.includes('bound to this repo'))).toBe(true);
    // The bound identity (work), NOT the global active one (personal), is shown.
    expect(lines.some(l => l.includes('global default'))).toBe(false);
  });

  it('shows the global active identity and the "dss link" hint when cwd is an unbound git repo', async () => {
    const store = storeOf(
      [{ name: 'personal', email: 'personal@example.com', userName: 'Personal', sshKeyPath: '/mock/personal/id_ed25519' }],
      'personal'
    );
    mockLoadStore.mockResolvedValue(store);
    mockGetRepositoryBindingStatus.mockResolvedValue({
      repositoryRoot: '/repo',
      configPath: '/repo/.git/dss/config',
      bound: false
    });

    await dashboard();

    const lines = loggedLines();
    expect(lines.some(l => l.includes('personal') && l.includes('global default'))).toBe(true);
    expect(lines.some(l => l.includes('dss link personal') && l.includes('bind it'))).toBe(true);
  });

  it('does NOT show the "dss link" hint when cwd is not a git repo at all (getRepositoryBindingStatus throws)', async () => {
    const store = storeOf(
      [{ name: 'personal', email: 'personal@example.com', userName: 'Personal', sshKeyPath: '/mock/personal/id_ed25519' }],
      'personal'
    );
    mockLoadStore.mockResolvedValue(store);
    mockGetRepositoryBindingStatus.mockRejectedValue(new Error('not a git repository'));

    await dashboard();

    const lines = loggedLines();
    expect(lines.some(l => l.includes('global default'))).toBe(true);
    expect(lines.some(l => l.includes('dss link'))).toBe(false);
  });

  it('shows "! no key" and a rotate hint for a keyless active identity, without crashing', async () => {
    const store = storeOf(
      [{ name: 'personal', email: 'personal@example.com', userName: 'Personal', sshKeyPath: '' }],
      'personal'
    );
    mockLoadStore.mockResolvedValue(store);
    mockGetRepositoryBindingStatus.mockRejectedValue(new Error('not a git repository'));

    await expect(dashboard()).resolves.toBeUndefined();

    const lines = loggedLines();
    expect(lines.some(l => l.includes('no key'))).toBe(true);
    expect(lines.some(l => l.includes('dss key rotate personal'))).toBe(true);
    expect(mockCheckKeyLoadedInAgent).not.toHaveBeenCalled();
  });

  it('shows key-missing (✗) when the key path is on record but the file is gone, without crashing', async () => {
    const store = storeOf(
      [{ name: 'personal', email: 'personal@example.com', userName: 'Personal', sshKeyPath: '/mock/personal/id_ed25519' }],
      'personal'
    );
    mockLoadStore.mockResolvedValue(store);
    mockGetRepositoryBindingStatus.mockRejectedValue(new Error('not a git repository'));
    mockFs.pathExists.mockResolvedValue(false as never);

    await expect(dashboard()).resolves.toBeUndefined();

    const lines = loggedLines();
    expect(lines.some(l => l.includes('key missing'))).toBe(true);
  });

  it('shows "! agent not loaded" when the key exists but isn\'t in the agent', async () => {
    const store = storeOf(
      [{ name: 'personal', email: 'personal@example.com', userName: 'Personal', sshKeyPath: '/mock/personal/id_ed25519' }],
      'personal'
    );
    mockLoadStore.mockResolvedValue(store);
    mockGetRepositoryBindingStatus.mockRejectedValue(new Error('not a git repository'));
    mockCheckKeyLoadedInAgent.mockResolvedValue({ loaded: false, checked: true, fingerprint: 'SHA256:abc' });

    await dashboard();

    const lines = loggedLines();
    expect(lines.some(l => l.includes('agent not loaded'))).toBe(true);
  });

  it('warns (never crashes) when no identity applies at all (no active identity, cwd unbound)', async () => {
    const store = storeOf([{ name: 'personal', email: 'p@example.com', userName: 'P', sshKeyPath: '' }]);
    mockLoadStore.mockResolvedValue(store);
    mockGetRepositoryBindingStatus.mockRejectedValue(new Error('not a git repository'));

    await expect(dashboard()).resolves.toBeUndefined();

    const lines = loggedLines();
    expect(lines.some(l => l.includes('No identity is active here'))).toBe(true);
  });

  it('prints the footer with the identity count, "dss ls", and "dss doctor"', async () => {
    const store = storeOf(
      [
        { name: 'work', email: 'w@example.com', userName: 'W', sshKeyPath: '' },
        { name: 'personal', email: 'p@example.com', userName: 'P', sshKeyPath: '' }
      ],
      'personal'
    );
    mockLoadStore.mockResolvedValue(store);
    mockGetRepositoryBindingStatus.mockRejectedValue(new Error('not a git repository'));

    await dashboard();

    const lines = loggedLines();
    expect(lines.some(l => l.includes('2 identities') && l.includes('dss ls'))).toBe(true);
    expect(lines.some(l => l.includes('dss doctor') && l.includes('full check'))).toBe(true);
  });

  it('NEVER calls testHostAccess or invokes ssh -T — the dashboard path makes no network calls', async () => {
    const store = storeOf(
      [{ name: 'personal', email: 'p@example.com', userName: 'P', sshKeyPath: '/mock/personal/id_ed25519' }],
      'personal'
    );
    mockLoadStore.mockResolvedValue(store);
    mockGetRepositoryBindingStatus.mockResolvedValue({
      repositoryRoot: '/repo',
      configPath: '/repo/.git/dss/config',
      bound: false
    });

    await dashboard();

    expect(mockTestHostAccess).not.toHaveBeenCalled();
    // Also assert no raw execFile call ever carries ssh's "-T" flag —
    // guards the invariant even if a future edit bypasses testHostAccess.
    const execFileCalls = (mockExecFile as unknown as jest.Mock).mock.calls;
    const sshDashTCalls = execFileCalls.filter(
      (call) => call[0] === 'ssh' && Array.isArray(call[1]) && call[1].includes('-T')
    );
    expect(sshDashTCalls).toHaveLength(0);
  });

  it('renders plainly under PLAIN mode (non-TTY, the Jest default) — no ANSI/box/unicode leakage beyond the plain glyph set', async () => {
    const store = storeOf(
      [{ name: 'personal', email: 'p@example.com', userName: 'P', sshKeyPath: '/mock/personal/id_ed25519' }],
      'personal'
    );
    mockLoadStore.mockResolvedValue(store);
    mockGetRepositoryBindingStatus.mockResolvedValue({
      repositoryRoot: '/repo',
      configPath: '/repo/.git/dss/config',
      bound: false
    });

    await dashboard();

    const lines = loggedLines();
    // eslint-disable-next-line no-control-regex
    const ansiRe = /\[[0-9;]*m/;
    for (const line of lines) {
      expect(line).not.toMatch(ansiRe);
      expect(line).not.toMatch(/[●·—]/);
    }
    // The active-identity marker degrades to the plain "* name" convention.
    expect(lines.some(l => l.includes('* personal'))).toBe(true);
    // The "unbound repo" hint line (which carries both a bullet and an
    // em-dash in rich mode) degrades to plain ASCII too.
    expect(lines.some(l => l.includes('this repo uses the global identity'))).toBe(true);
  });
});
