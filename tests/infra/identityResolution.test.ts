import fs from 'fs-extra';
import { fromSpace } from '../../src/infra/store';
import { getRepositoryBindingStatus } from '../../src/infra/repoBinding';
import { resolveAppliesHere } from '../../src/infra/identityResolution';
import { IStoreV2, ISpace } from '../../src/core/types';

// resolveAppliesHere (Phase 5 · Task 3 §0): the "which identity applies
// HERE" precedence — bound > directory rule > global default — extracted
// from the dashboard's original inline resolution so doctor's commit-drift
// check and `dss guard check` share the exact same logic. Unit-tested here
// against the underlying infra it composes (getRepositoryBindingStatus,
// fs.realpath) rather than a real repo, mirroring dashboard.test.ts's own
// mocking style for the code this was extracted from.

jest.mock('fs-extra');
jest.mock('../../src/infra/repoBinding', () => ({
  getRepositoryBindingStatus: jest.fn()
}));

const mockFs = fs as jest.Mocked<typeof fs>;
const mockGetRepositoryBindingStatus = getRepositoryBindingStatus as jest.MockedFunction<typeof getRepositoryBindingStatus>;

function storeOf(spaces: ISpace[], active?: string, rules: IStoreV2['rules'] = []): IStoreV2 {
  return { version: 2, identities: spaces.map(fromSpace), active, bindings: [], rules };
}

const work: ISpace = { name: 'work', email: 'work@example.com', userName: 'Work User', sshKeyPath: '' };
const personal: ISpace = { name: 'personal', email: 'personal@example.com', userName: 'Personal User', sshKeyPath: '' };

describe('infra/identityResolution: resolveAppliesHere', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('resolves the BOUND identity when cwd is bound', async () => {
    const store = storeOf([work, personal], 'personal', [{ dir: '/code/acme', identity: 'personal' }]);
    mockGetRepositoryBindingStatus.mockResolvedValue({
      repositoryRoot: '/repo',
      configPath: '/repo/.git/dss/config',
      bound: true,
      spaceName: 'work'
    });

    const result = await resolveAppliesHere('/repo', store);

    expect(result.source).toBe('bound');
    expect(result.identity?.name).toBe('work');
  });

  it('falls back to a matching directory RULE when unbound', async () => {
    const store = storeOf([work, personal], 'work', [{ dir: '/code/acme', identity: 'personal' }]);
    mockGetRepositoryBindingStatus.mockResolvedValue({
      repositoryRoot: '/code/acme/project',
      configPath: '/code/acme/project/.git/dss/config',
      bound: false
    });
    mockFs.realpath.mockResolvedValue('/code/acme/project' as never);

    const result = await resolveAppliesHere('/code/acme/project', store);

    expect(result.source).toBe('rule');
    expect(result.identity?.name).toBe('personal');
  });

  it('falls back to the GLOBAL active identity when unbound and outside every rule', async () => {
    const store = storeOf([work, personal], 'work', [{ dir: '/code/acme', identity: 'personal' }]);
    mockGetRepositoryBindingStatus.mockResolvedValue({
      repositoryRoot: '/elsewhere',
      configPath: '/elsewhere/.git/dss/config',
      bound: false
    });
    mockFs.realpath.mockResolvedValue('/elsewhere' as never);

    const result = await resolveAppliesHere('/elsewhere', store);

    expect(result.source).toBe('global');
    expect(result.identity?.name).toBe('work');
  });

  it('resolves { identity: null, source: null } when NONE applies (unbound, no rule, no active)', async () => {
    const store = storeOf([work, personal], undefined, [{ dir: '/code/acme', identity: 'personal' }]);
    mockGetRepositoryBindingStatus.mockResolvedValue({
      repositoryRoot: '/elsewhere',
      configPath: '/elsewhere/.git/dss/config',
      bound: false
    });
    mockFs.realpath.mockResolvedValue('/elsewhere' as never);

    const result = await resolveAppliesHere('/elsewhere', store);

    expect(result).toEqual({ identity: null, source: null });
  });

  it('treats getRepositoryBindingStatus throwing (cwd not a git repo) as unbound, not a crash', async () => {
    const store = storeOf([work], 'work');
    mockGetRepositoryBindingStatus.mockRejectedValue(new Error('not a git repository'));

    const result = await resolveAppliesHere('/not-a-repo', store);

    expect(result.source).toBe('global');
    expect(result.identity?.name).toBe('work');
  });

  it('falls through to the next precedence step when a binding names a space that no longer exists', async () => {
    const store = storeOf([work], 'work');
    mockGetRepositoryBindingStatus.mockResolvedValue({
      repositoryRoot: '/repo',
      configPath: '/repo/.git/dss/config',
      bound: true,
      spaceName: 'deleted-space'
    });
    mockFs.realpath.mockResolvedValue('/repo' as never);

    const result = await resolveAppliesHere('/repo', store);

    expect(result.source).toBe('global');
    expect(result.identity?.name).toBe('work');
  });

  it('falls through to the next precedence step when a matching rule names a missing identity', async () => {
    const store = storeOf([work], 'work', [{ dir: '/code/acme', identity: 'missing-identity' }]);
    mockGetRepositoryBindingStatus.mockResolvedValue({
      repositoryRoot: '/code/acme/project',
      configPath: '/code/acme/project/.git/dss/config',
      bound: false
    });
    mockFs.realpath.mockResolvedValue('/code/acme/project' as never);

    const result = await resolveAppliesHere('/code/acme/project', store);

    expect(result.source).toBe('global');
    expect(result.identity?.name).toBe('work');
  });
});
