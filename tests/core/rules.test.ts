import { matchRule } from '../../src/core/rules';
import { IRule } from '../../src/core/types';

describe('core/rules — matchRule (pure, boundary-aware, longest-prefix)', () => {
  it('returns undefined for an empty rule set', () => {
    expect(matchRule('/a/b', [])).toBeUndefined();
  });

  it('matches an exact directory', () => {
    const rules: IRule[] = [{ dir: '/a/b', identity: 'work' }];
    expect(matchRule('/a/b', rules)).toEqual({ dir: '/a/b', identity: 'work' });
  });

  it('matches a directory nested beneath a rule', () => {
    const rules: IRule[] = [{ dir: '/a/b', identity: 'work' }];
    expect(matchRule('/a/b/c/d', rules)).toEqual({ dir: '/a/b', identity: 'work' });
  });

  it('does NOT match a sibling directory sharing only a string prefix (/a/bc must not match /a/b)', () => {
    const rules: IRule[] = [{ dir: '/a/b', identity: 'work' }];
    expect(matchRule('/a/bc', rules)).toBeUndefined();
    expect(matchRule('/a/bc/d', rules)).toBeUndefined();
  });

  it('does NOT match an unrelated directory', () => {
    const rules: IRule[] = [{ dir: '/a/b', identity: 'work' }];
    expect(matchRule('/x/y', rules)).toBeUndefined();
  });

  it('does NOT match a parent of the rule directory', () => {
    const rules: IRule[] = [{ dir: '/a/b', identity: 'work' }];
    expect(matchRule('/a', rules)).toBeUndefined();
  });

  it('picks the most specific (longest) rule when nested rules both match', () => {
    const rules: IRule[] = [
      { dir: '/code', identity: 'general' },
      { dir: '/code/acme', identity: 'acme-specific' }
    ];
    expect(matchRule('/code/acme/project', rules)).toEqual({ dir: '/code/acme', identity: 'acme-specific' });
  });

  it('picks the most specific rule regardless of array order', () => {
    const rules: IRule[] = [
      { dir: '/code/acme', identity: 'acme-specific' },
      { dir: '/code', identity: 'general' }
    ];
    expect(matchRule('/code/acme/project', rules)).toEqual({ dir: '/code/acme', identity: 'acme-specific' });
  });

  it('falls back to the broader rule outside the nested rule\'s directory', () => {
    const rules: IRule[] = [
      { dir: '/code', identity: 'general' },
      { dir: '/code/acme', identity: 'acme-specific' }
    ];
    expect(matchRule('/code/other-client/project', rules)).toEqual({ dir: '/code', identity: 'general' });
  });

  it('is a no-op for rules on an entirely different subtree', () => {
    const rules: IRule[] = [{ dir: '/code/personal', identity: 'personal' }];
    expect(matchRule('/code/work/project', rules)).toBeUndefined();
  });
});
