import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { IRule } from '../core/types';
import { identityGitconfigPath, quoteGitConfigValue } from './git';

const GITDIR_SEPARATOR = '/';

/** Absolute path to the DSS-managed, always-included file compiling every
 * directory rule to a native `includeIf "gitdir:...">` section. */
export function rulesGitconfigPath(): string {
  return path.join(os.homedir(), '.dss', 'rules.gitconfig');
}

/** Mirrors the includeIf quoting-safety class from repo-local binding
 * (Phase 2): a raw `\n`/`\r` in a directory that's about to be written into
 * a globally-included gitconfig section header could corrupt the file's
 * line structure or splice attacker-controlled config into it. */
export function containsLineBreak(value: string): boolean {
  return /[\r\n]/.test(value);
}

/**
 * Canonicalizes a user-supplied directory for rule storage: `~` expansion,
 * absolute resolution, and symlink resolution via fs.realpath WHEN the path
 * exists (falling back to the plain resolved path when it doesn't — needed
 * so `dss rule rm` can still match/remove a rule whose directory has since
 * been deleted or renamed). Never adds a trailing separator — callers that
 * need one (the rules-file compiler) add exactly one themselves.
 */
export async function canonicalizeRuleDir(inputDir: string): Promise<string> {
  const expanded = inputDir === '~' || inputDir.startsWith(`~${path.sep}`)
    ? path.join(os.homedir(), inputDir.slice(1))
    : inputDir;
  const resolved = path.resolve(expanded);

  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Renders the exact ~/.dss/rules.gitconfig content for `rules`: one
 * `[includeIf "gitdir:<dir>/"]` section per rule (dir with exactly one
 * trailing slash — git's gitdir pattern semantics: a trailing `/` matches
 * that directory and everything beneath it), pointing `path` at that rule's
 * identity gitconfig. Pure/sync so tests can assert the exact text without
 * touching disk. Empty input renders an empty string (an empty file is a
 * valid, harmless rules.gitconfig — its `include.path` entry simply
 * includes nothing).
 */
export function renderRulesGitconfig(rules: IRule[]): string {
  return rules.map(rule => {
    if (containsLineBreak(rule.dir)) {
      throw new Error(
        `Refusing to write rules.gitconfig: a rule directory contains a line break, ` +
        `which could corrupt or inject into this globally-included config file: ${JSON.stringify(rule.dir)}`
      );
    }

    const dirWithTrailingSlash = rule.dir.endsWith(GITDIR_SEPARATOR)
      ? rule.dir
      : `${rule.dir}${GITDIR_SEPARATOR}`;
    const header = `[includeIf ${quoteGitConfigValue(`gitdir:${dirWithTrailingSlash}`)}]`;
    const pathLine = `\tpath = ${quoteGitConfigValue(identityGitconfigPath(rule.identity))}`;
    return `${header}\n${pathLine}\n`;
  }).join('');
}

/** Atomically regenerates ~/.dss/rules.gitconfig (full rewrite) from
 * `rules` — called on every rule mutation (add/rm). */
export async function writeRulesGitconfig(rules: IRule[]): Promise<void> {
  const configPath = rulesGitconfigPath();
  const content = renderRulesGitconfig(rules);

  await fs.ensureDir(path.dirname(configPath));
  const tmpPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, content);
  await fs.move(tmpPath, configPath, { overwrite: true });
}
