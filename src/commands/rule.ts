import fs from 'fs-extra';
import { UsageError } from './prompts';
import { UIHelper } from './ui';
import { fail } from './fail';
import { findIdentity } from '../core/identity';
import { loadStore, saveStore, upsertRule, removeRule } from '../infra/store';
import { canonicalizeRuleDir, containsLineBreak, writeRulesGitconfig, rulesGitconfigPath } from '../infra/rules';
import { writeIdentityGitconfig, ensureGlobalInclude } from '../infra/git';
import { jsonData } from './jsonOutput';

/**
 * `dss rule add <directory> <identityName>`: upserts a directory rule
 * (same canonical directory replaces its identity), writes the ruled
 * identity's own gitconfig, regenerates rules.gitconfig from the full rule
 * set, and ensures the global gitconfig includes it — the same
 * includeIf-first shape `dss use`/`dss link` already use, just conditioned
 * on `gitdir:` instead of applied unconditionally or per-repo.
 */
export async function addRule(directory: string, identityName: string): Promise<void> {
  const store = await loadStore();

  const identity = findIdentity(store, identityName);
  if (!identity) {
    fail(`Identity "${identityName}" was not found.`);
    return;
  }

  const canonicalDir = await canonicalizeRuleDir(directory);

  // Reject (UsageError, exit 2) rather than fail() (exit 1): this is the
  // same includeIf quoting-safety class as the repo-binding path check
  // (Phase 2) — a directory NAME can legally contain \n/\r on POSIX, and
  // writing it verbatim into a globally-included gitconfig section header
  // would corrupt or inject into that file. Checked here (bad usage, not an
  // operational failure) before the compiler's own hard-gate defense
  // (infra/rules.ts's renderRulesGitconfig) would ever see it.
  if (containsLineBreak(canonicalDir)) {
    throw new UsageError(
      `Directory contains a line break, which cannot safely be written into an includeIf section: ${JSON.stringify(directory)}`
    );
  }

  let stats;
  try {
    stats = await fs.stat(canonicalDir);
  } catch {
    fail(`Directory does not exist: ${directory}`);
    return;
  }
  if (!stats.isDirectory()) {
    fail(`Not a directory: ${directory}`);
    return;
  }

  upsertRule(store, canonicalDir, identity.name);

  try {
    await writeIdentityGitconfig(identity);
    await writeRulesGitconfig(store.rules);
    await ensureGlobalInclude(rulesGitconfigPath());
  } catch (error) {
    fail(`Failed to write the directory rule: ${(error as Error).message}`);
    return;
  }

  await saveStore(store);

  UIHelper.success(`Directory rule added: ${UIHelper.filename(canonicalDir)} ${UIHelper.dim('->')} ${UIHelper.highlight(identity.name)}`);
  jsonData({ added: { dir: canonicalDir, identity: identity.name }, rules: store.rules.length });
}

/** `dss rule ls`: lists every directory rule (dir -> identity). */
export async function listRules(): Promise<void> {
  const store = await loadStore();

  UIHelper.printHeader('Directory Rules');
  UIHelper.printRuleTable(store.rules);

  jsonData({ rules: store.rules.map(rule => ({ dir: rule.dir, identity: rule.identity })) });
}

/**
 * `dss rule rm <directory>`: removes the matching rule (canonicalized the
 * same way `add` stores it) and regenerates rules.gitconfig — an empty
 * rules.gitconfig when no rules remain, keeping the (now harmless)
 * `include.path` entry in place rather than trying to remove it.
 */
export async function rmRule(directory: string): Promise<void> {
  const store = await loadStore();
  const canonicalDir = await canonicalizeRuleDir(directory);

  const removed = removeRule(store, canonicalDir);
  if (!removed) {
    fail(`No directory rule found for: ${canonicalDir}`);
    return;
  }

  try {
    await writeRulesGitconfig(store.rules);
  } catch (error) {
    fail(`Failed to update the rules file: ${(error as Error).message}`);
    return;
  }

  await saveStore(store);

  UIHelper.success(`Directory rule removed: ${UIHelper.filename(canonicalDir)}`);
  jsonData({ removed: canonicalDir, rules: store.rules.length });
}
