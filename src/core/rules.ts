import path from 'path';
import { IRule } from './types';

/**
 * Longest-prefix, boundary-aware match of a canonical `dir` against a set of
 * directory rules — the same semantics DSS relies on when compiling rules
 * to git's own `includeIf "gitdir:<dir>/"` (a path ending in `/` matches
 * that directory and everything beneath it). `rule.dir` is assumed to
 * already be a canonical, absolute path with no trailing separator (see
 * infra/rules.ts's canonicalizeRuleDir) — this function does no
 * normalization of its own, only comparison, so it stays pure and
 * synchronous for reuse anywhere a rule needs to be resolved against a
 * directory (dashboard, doctor, clone, prompt templates).
 *
 * Boundary-aware: a rule for `/a/b` must NOT match `/a/bc` — only `/a/b`
 * itself or anything under `/a/b/`. When more than one rule matches
 * (nested rules), the most specific (longest `dir`) wins.
 */
export function matchRule(dir: string, rules: IRule[]): IRule | undefined {
  let best: IRule | undefined;

  for (const rule of rules) {
    const isExactMatch = dir === rule.dir;
    const isNestedMatch = dir.startsWith(rule.dir.endsWith(path.sep) ? rule.dir : `${rule.dir}${path.sep}`);
    if (!isExactMatch && !isNestedMatch) continue;

    if (!best || rule.dir.length > best.dir.length) {
      best = rule;
    }
  }

  return best;
}
