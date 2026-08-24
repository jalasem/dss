import fs from 'fs-extra';
import { loadStore } from '../infra/store';
import { findIdentity, slugify } from '../core/identity';
import { matchRule } from '../core/rules';
import { IIdentity, IStoreV2 } from '../core/types';
import { getRepositoryBindingStatus, RepositoryBindingStatus } from '../infra/repoBinding';
import { checkKeyLoadedInAgent, checkSshConfigHost, checkHostAccess } from '../infra/ssh';
import { getGitUser } from '../infra/git';
import { UIHelper } from './ui';
import { fail } from './fail';
import { EXIT_CODES } from '../core/exitCodes';
import { jsonData, jsonFail } from './jsonOutput';

type CheckStatus = 'success' | 'error' | 'warning' | 'info';
type JsonCheckStatus = 'ok' | 'warn' | 'error';

interface DoctorCheck {
  name: string;
  status: JsonCheckStatus;
  detail: string;
}

interface DoctorRun {
  sawHardFailure: boolean;
  issues: string[];
  checks: DoctorCheck[];
}

function section(title: string): void {
  UIHelper.print('');
  UIHelper.print(UIHelper.dim(`${title}:`));
}

function toJsonCheckStatus(status: CheckStatus): JsonCheckStatus {
  if (status === 'warning') return 'warn';
  if (status === 'error') return 'error';
  return 'ok';
}

/** Renders one checklist line and folds it into the run's issue/failure/
 * JSON-check tally. */
function report(run: DoctorRun, status: CheckStatus, label: string, value: string, hint?: string): void {
  UIHelper.printStatus(label, value, status);
  run.checks.push({ name: label, status: toJsonCheckStatus(status), detail: value });
  if (status === 'error') {
    run.sawHardFailure = true;
    run.issues.push(hint ?? `${label}: ${value}`);
  } else if (status === 'warning') {
    run.issues.push(hint ?? `${label}: ${value}`);
  }
}

function resolveIdentity(
  store: IStoreV2,
  identityName: string | undefined,
  bindingStatus: RepositoryBindingStatus | undefined
): { identity?: IIdentity; source: 'named' | 'bound' | 'active' } {
  if (identityName) {
    return { identity: findIdentity(store, identityName), source: 'named' };
  }

  if (bindingStatus?.bound && bindingStatus.spaceName) {
    const bound = findIdentity(store, bindingStatus.spaceName);
    if (bound) return { identity: bound, source: 'bound' };
  }

  if (store.active) {
    return { identity: findIdentity(store, store.active), source: 'active' };
  }

  return { identity: undefined, source: 'active' };
}

/**
 * `dss doctor [identityName]` — absorbs `test` (host auth) and `inspect`
 * (detailed identity/key/config report), plus a Git-identity-drift check
 * and the repo-binding summary. Unlike the bare-`dss` dashboard, this is
 * allowed to be slow: it makes the one network call, via the PURE
 * `checkHostAccess` (never `testHostAccess` — that prompts to show the
 * public key, which would hang a script/CI invocation of doctor waiting
 * on stdin; doctor must never prompt).
 *
 * Exit-code calibration: ✗ (hard failure — auth failed, key missing) sets
 * process.exitCode = 1; ! (attention — drift, perms, agent-not-loaded,
 * ssh-config mismatch) does not.
 */
export async function doctor(identityName?: string): Promise<void> {
  const store = await loadStore();

  let bindingStatus: RepositoryBindingStatus | undefined;
  try {
    bindingStatus = await getRepositoryBindingStatus(process.cwd());
  } catch {
    bindingStatus = undefined;
  }

  const { identity } = resolveIdentity(store, identityName, bindingStatus);
  if (!identity) {
    if (identityName) {
      fail(`Identity "${identityName}" not found.`);
    } else {
      fail('No identity to check: no active identity, and this repository is not bound to one.');
      UIHelper.info(`Specify an identity (${UIHelper.command('dss doctor <name>')}) or run ${UIHelper.command('dss use')} first.`);
    }
    return;
  }

  UIHelper.printHeader(`Doctor: ${identity.name}`);

  const run: DoctorRun = { sawHardFailure: false, issues: [], checks: [] };
  const isActive = Boolean(store.active) && slugify(store.active as string) === slugify(identity.name);
  const boundHere = Boolean(
    bindingStatus?.bound && bindingStatus.spaceName && slugify(bindingStatus.spaceName) === slugify(identity.name)
  );

  section('Identity');
  report(run, 'info', 'Name', identity.name);
  report(run, 'info', 'Email', identity.email);
  report(run, 'info', 'Username', identity.userName);
  report(run, 'info', 'Host', identity.host);
  report(run, 'info', 'Active', isActive ? 'yes' : 'no');
  report(run, 'info', 'Bound here', bindingStatus ? (boundHere ? 'yes' : 'no') : 'n/a (not a git repository)');

  section('Key');
  if (!identity.key) {
    report(run, 'error', 'Key', 'no SSH key configured', `dss key rotate ${identity.name}`);
  } else {
    const key = identity.key;
    const privateExists = await fs.pathExists(key.path);
    const publicExists = await fs.pathExists(`${key.path}.pub`);
    report(run, privateExists ? 'success' : 'error', 'Private key', privateExists ? key.path : 'missing',
      privateExists ? undefined : `private key file missing at ${key.path} — dss key rotate ${identity.name}`);
    report(run, publicExists ? 'success' : 'error', 'Public key', publicExists ? `${key.path}.pub` : 'missing',
      publicExists ? undefined : `public key file missing — dss key rotate ${identity.name}`);
    report(run, 'info', 'Algorithm', key.algorithm);
    report(run, 'info', 'Fingerprint', key.fingerprint ?? 'unknown');

    if (privateExists) {
      try {
        const stats = await fs.stat(key.path);
        const permissions = (stats.mode & parseInt('777', 8)).toString(8);
        const secure = permissions === '600';
        report(run, secure ? 'success' : 'warning', 'Permissions', permissions,
          secure ? undefined : `key file permissions are ${permissions}, expected 600 — chmod 600 ${key.path}`);
      } catch {
        report(run, 'warning', 'Permissions', 'unable to check', 'unable to check key file permissions');
      }
    }

    if (publicExists) {
      const agentCheck = await checkKeyLoadedInAgent(`${key.path}.pub`);
      if (!agentCheck.checked) {
        report(run, 'warning', 'Agent', 'unable to check', 'unable to check whether the key is loaded in the ssh-agent');
      } else {
        report(run, agentCheck.loaded ? 'success' : 'warning', 'Agent', agentCheck.loaded ? 'loaded' : 'not loaded',
          agentCheck.loaded ? undefined : `key not loaded in ssh-agent — ssh-add ${key.path}`);
      }
    }
  }

  section('ssh-config');
  if (!identity.key) {
    report(run, 'warning', 'Host block', 'skipped (no key)', 'ssh-config check skipped — no key to match against');
  } else {
    const configCheck = await checkSshConfigHost(identity.host, identity.key.path);
    if (configCheck === 'match') {
      report(run, 'success', 'Host block', `matches (Host ${identity.host})`);
    } else if (configCheck === 'points-elsewhere') {
      report(run, 'warning', 'Host block', `points elsewhere (Host ${identity.host})`,
        `~/.ssh/config's Host ${identity.host} block does not point at this identity's key — dss use ${identity.name}`);
    } else {
      report(run, 'warning', 'Host block', `absent (Host ${identity.host})`,
        `no Host ${identity.host} block in ~/.ssh/config — dss use ${identity.name}`);
    }
  }

  section('Host auth (network)');
  if (!identity.key) {
    report(run, 'warning', 'Host auth', 'skipped (no key)', 'host auth check skipped — no key to authenticate with');
  } else {
    const hostAuth = await checkHostAccess(identity.key.path, identity.host);
    report(run, hostAuth.ok ? 'success' : 'error', 'Host auth', hostAuth.ok ? 'authenticated' : hostAuth.detail,
      hostAuth.ok ? undefined : `SSH authentication to ${identity.host} failed — check the public key is added to your ${identity.host} account`);
  }

  section('Git identity drift');
  try {
    const gitUser = await getGitUser();
    const matches = gitUser.userName === identity.userName && gitUser.email === identity.email;
    report(run, matches ? 'success' : 'warning', 'Git identity', `${gitUser.userName} <${gitUser.email}>`,
      matches ? undefined : `global git identity doesn't match "${identity.name}" — dss use ${identity.name}`);
  } catch {
    report(run, 'warning', 'Git identity', 'unable to check', 'unable to read the global git user.name/user.email');
  }

  if (bindingStatus) {
    section('Repo binding');
    report(run, 'info', 'Repository', bindingStatus.repositoryRoot);
    if (bindingStatus.bound) {
      report(run, boundHere ? 'success' : 'warning', 'Binding', bindingStatus.spaceName ?? 'unknown',
        boundHere ? undefined : `this repo is bound to "${bindingStatus.spaceName}", not "${identity.name}"`);
    } else {
      report(run, 'info', 'Binding', 'not bound');
    }
  }

  // Small, cwd-scoped addition (keeps doctor the one health surface): when
  // the current directory falls under a configured rule, check that git's
  // own includeIf resolution is actually landing on the ruled identity here
  // — independent of which identity THIS doctor run is checking, since a
  // rule can apply to a different identity than the one named/active/bound.
  let ruleMatch: ReturnType<typeof matchRule>;
  try {
    const canonicalCwd = await fs.realpath(process.cwd());
    ruleMatch = matchRule(canonicalCwd, store.rules);
  } catch {
    ruleMatch = undefined;
  }

  if (ruleMatch) {
    section('Directory rule');
    const ruledIdentity = findIdentity(store, ruleMatch.identity);
    if (!ruledIdentity) {
      report(run, 'warning', 'Rule', `${ruleMatch.dir} -> "${ruleMatch.identity}" (identity not found)`,
        `directory rule at ${ruleMatch.dir} references a missing identity "${ruleMatch.identity}"`);
    } else {
      report(run, 'info', 'Rule', `${ruleMatch.dir} -> ${ruledIdentity.name}`);
      try {
        const gitUser = await getGitUser();
        const matches = gitUser.userName === ruledIdentity.userName && gitUser.email === ruledIdentity.email;
        report(run, matches ? 'success' : 'warning', 'Rule drift',
          matches ? 'matches' : `${gitUser.userName} <${gitUser.email}> (expected ${ruledIdentity.userName} <${ruledIdentity.email}>)`,
          matches ? undefined : `the effective git identity here doesn't match the directory rule for "${ruledIdentity.name}" — ` +
            `check ~/.dss/rules.gitconfig is included after active.gitconfig in ~/.gitconfig, and no repo-local binding overrides it`);
      } catch {
        report(run, 'warning', 'Rule drift', 'unable to check', 'unable to read the effective git user.name/user.email here');
      }
    }
  }

  UIHelper.print('');
  if (!run.sawHardFailure && run.issues.length === 0) {
    UIHelper.success('All checks passed.');
  } else {
    const shortestHint = [...run.issues].sort((a, b) => a.length - b.length)[0];
    UIHelper.warning(`${run.issues.length} issue${run.issues.length === 1 ? '' : 's'} — ${shortestHint}`);
  }

  const summary = run.checks.reduce(
    (totals, check) => {
      totals[check.status]++;
      return totals;
    },
    { ok: 0, warn: 0, error: 0 }
  );
  jsonData({ identity: identity.name, checks: run.checks, summary });

  if (run.sawHardFailure) {
    process.exitCode = EXIT_CODES.FAILURE;
    // Doctor never routes its hard-failure summary through fail() (its
    // checklist-style output has no single "the operation failed" message
    // to print) — without an explicit jsonFail() call here, flushJson()'s
    // generic "command failed" fallback would be the only error message a
    // --json caller ever sees, telling them nothing the checks[] above
    // didn't already say better (review finding #2).
    jsonFail(`${summary.error} check(s) failed`);
  }
}
