import { confirm, password, select, input, checkbox } from '@inquirer/prompts';
import { KNOWN_HOSTS } from '../core/hosts';
import { EXIT_CODES } from '../core/exitCodes';
import { isJsonMode } from './jsonOutput';

// @inquirer/prompts throws ExitPromptError when stdin closes (piped input
// exhausted, non-interactive shell) or the user presses Ctrl+C.
// The class does not override `name`, and nested copies of @inquirer/core
// break instanceof, so match on the constructor's class name instead.
export function isPromptExitError(error: unknown): boolean {
  return error instanceof Error &&
    (error.constructor.name === 'ExitPromptError' || error.name === 'ExitPromptError');
}

// Treats a closed prompt as "declined" so optional prompts never surface
// a cancellation as a command failure or perform side effects.
export async function safeConfirm(options: {
  message: string;
  default?: boolean;
}): Promise<boolean> {
  try {
    return await confirm(options);
  } catch (error) {
    if (isPromptExitError(error)) return false;
    throw error;
  }
}

// Treats a closed password prompt as "no passphrase" so it never surfaces a
// cancellation as a command failure.
export async function safePassword(options: {
  message: string;
  mask?: boolean | string;
}): Promise<string> {
  try {
    return await password({ mask: true, ...options });
  } catch (error) {
    if (isPromptExitError(error)) return '';
    throw error;
  }
}

const OTHER_HOST_SENTINEL = '__other__';

export function validateCustomHost(value: string): string | true {
  const trimmed = value.trim();
  if (!trimmed) return 'Host is required.';
  if (/\s/.test(trimmed)) return 'Host must not contain spaces.';
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    return 'Host must not include a protocol (e.g. remove "https://").';
  }
  return true;
}

/**
 * Prompts for a Git host: a select among the known hosts plus "Other…",
 * which falls through to a free-form input validated as a bare hostname
 * (non-empty, no spaces, no protocol). `currentHost` (if given) is
 * highlighted as the select's default choice.
 */
export async function promptHost(currentHost?: string): Promise<string> {
  const choice = await select({
    message: 'Git host:',
    choices: [
      ...KNOWN_HOSTS.map((host) => ({ name: host, value: host as string })),
      { name: 'Other…', value: OTHER_HOST_SENTINEL }
    ],
    default: currentHost ?? KNOWN_HOSTS[0]
  });

  if (choice !== OTHER_HOST_SENTINEL) return choice;

  return input({
    message: 'Custom Git host (e.g. git.example.com):',
    validate: validateCustomHost
  });
}

// --- Non-interactive foundation ------------------------------------------
//
// Every prompt in src/commands/ flows through the guarded* wrappers below
// instead of calling @inquirer/prompts (or safeConfirm/safePassword)
// directly. In interactive mode they behave exactly like the prompt they
// wrap; in non-interactive mode (see isNonInteractive) they NEVER touch
// stdin — they either resolve a documented default or throw a UsageError
// naming the flag/positional a script must pass instead.

/**
 * True when this process should never wait on stdin for a prompt answer:
 * `DSS_NO_INPUT=1` is set, stdin is not a TTY (piped/closed/redirected, the
 * shape any script or CI runner uses), or `--json` is on (a machine-
 * readable invocation must never block on a prompt either — see
 * src/commands/jsonOutput.ts). A live check — like ui.ts's isPlain() — not
 * a value captured once at startup, so tests (and a long-lived process
 * whose stdin changes) always see the current state.
 */
export function isNonInteractive(): boolean {
  return process.env.DSS_NO_INPUT === '1' || !process.stdin.isTTY || isJsonMode();
}

let assumeYesFlag = false;

/** Registered from the global `-y, --yes` Commander option (index.ts). */
export function setAssumeYes(value: boolean): void {
  assumeYesFlag = value;
}

export function assumeYes(): boolean {
  return assumeYesFlag;
}

/**
 * Thrown by a guarded prompt wrapper when it can't get an answer without
 * touching stdin and there's no usable default. Carries exitCode 2 (the
 * CLI's "bad/missing usage" exit code) for index.ts's top-level handler to
 * apply via `process.exitCode` — see handleTopLevelError.
 */
export class UsageError extends Error {
  readonly exitCode = EXIT_CODES.USAGE;
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

interface GuardedValueOptions {
  /** The flag (e.g. "--name") or positional (e.g. "the identityName
   * argument") a script should pass instead of answering this prompt. */
  flagName: string;
  /** When set, non-interactive mode resolves to this value instead of
   * throwing — for prompts that have a sensible default (e.g. `dss edit`
   * keeping a field's current value, or an empty passphrase). Omit for
   * prompts with no safe default (e.g. a brand-new identity's name). */
  nonInteractiveDefault?: string;
}

type InputConfig = Parameters<typeof input>[0];
type PasswordConfig = Parameters<typeof password>[0];
type SelectChoice = { name?: string; value: string; description?: string; disabled?: boolean | string };
interface SelectConfig {
  message: string;
  choices: readonly SelectChoice[];
  default?: unknown;
}
type CheckboxChoice = { name?: string; value: string; description?: string; checked?: boolean; disabled?: boolean | string };
interface CheckboxConfig {
  message: string;
  choices: readonly CheckboxChoice[];
  required?: boolean;
}
interface GuardedCheckboxOptions {
  /** The flag (e.g. "--all") a script should pass instead of answering this
   * prompt — see guardedCheckbox's own note on why this is largely
   * theoretical today (every current call site supplies
   * nonInteractiveDefault, so this never actually throws yet), but every
   * other guarded wrapper requires it, and a future required-selection
   * checkbox will need it for real. */
  flagName: string;
  /** When set, non-interactive mode resolves to this value instead of
   * throwing (e.g. "all choices selected" for `dss config export`). */
  nonInteractiveDefault?: string[];
}

/** Guarded `input`: interactive → normal prompt; non-interactive → the
 * configured default, or a UsageError naming `flagName`. Never touches
 * stdin in non-interactive mode. */
export async function guardedInput(opts: InputConfig & GuardedValueOptions): Promise<string> {
  const { flagName, nonInteractiveDefault, ...rest } = opts;
  if (isNonInteractive()) {
    if (nonInteractiveDefault !== undefined) return nonInteractiveDefault;
    throw new UsageError(`Missing required value: pass ${flagName} (non-interactive mode)`);
  }
  return input(rest);
}

/** Guarded `select` (string-valued choices only — every select in this
 * codebase picks a name/host/shell). Same interactive/non-interactive
 * contract as guardedInput. */
export async function guardedSelect(opts: SelectConfig & GuardedValueOptions): Promise<string> {
  const { flagName, nonInteractiveDefault, ...rest } = opts;
  if (isNonInteractive()) {
    if (nonInteractiveDefault !== undefined) return nonInteractiveDefault;
    throw new UsageError(`Missing required value: pass ${flagName} (non-interactive mode)`);
  }
  return select(rest);
}

/** Guarded `safePassword`. Same contract as guardedInput; a passphrase
 * prompt typically passes `nonInteractiveDefault: ''` (empty passphrase is
 * a legitimate default, matching the interactive default). */
export async function guardedPassword(opts: PasswordConfig & GuardedValueOptions): Promise<string> {
  const { flagName, nonInteractiveDefault, ...rest } = opts;
  if (isNonInteractive()) {
    if (nonInteractiveDefault !== undefined) return nonInteractiveDefault;
    throw new UsageError(`Missing required value: pass ${flagName} (non-interactive mode)`);
  }
  return safePassword(rest);
}

/** Guarded `promptHost` (select + optional "Other…" free-form input,
 * bundled behind promptHost). Same contract as guardedInput/guardedSelect. */
export async function guardedPromptHost(
  opts: { currentHost?: string } & GuardedValueOptions
): Promise<string> {
  const { flagName, nonInteractiveDefault, currentHost } = opts;
  if (isNonInteractive()) {
    if (nonInteractiveDefault !== undefined) return nonInteractiveDefault;
    throw new UsageError(`Missing required value: pass ${flagName} (non-interactive mode)`);
  }
  return promptHost(currentHost);
}

/**
 * Guarded `confirm`. `-y/--yes` (assumeYes()) always affirms — interactive
 * or not, required or optional — skipping the prompt entirely. Otherwise:
 * interactive → safeConfirm as today. Non-interactive → a REQUIRED confirm
 * (the default: `optional` unset/false) throws a UsageError naming
 * `flag` (default "-y/--yes"); an OPTIONAL/informational confirm
 * (`optional: true` — a nice-to-have extra, never destructive) resolves
 * false silently instead, so a script isn't forced to pass -y just to
 * avoid a hang or an error on a prompt whose answer doesn't gate anything
 * essential.
 */
export async function guardedConfirm(opts: {
  message: string;
  default?: boolean;
  flag?: string;
  optional?: boolean;
}): Promise<boolean> {
  if (assumeYes()) return true;
  if (!isNonInteractive()) {
    return safeConfirm({ message: opts.message, default: opts.default });
  }
  if (opts.optional) return false;
  throw new UsageError(`Confirmation required: pass ${opts.flag ?? '-y/--yes'} (non-interactive mode)`);
}

/** Guarded `checkbox` (multi-select; string-valued choices only — the one
 * checkbox in this codebase, `dss config export`'s identity picker). Same
 * interactive/non-interactive contract as guardedSelect, except the default
 * is an array: pass `nonInteractiveDefault: choices.map(c => c.value)` for
 * a "select everything" default (a script exporting non-interactively
 * wants all identities, not none), or omit it for a genuinely required
 * selection with no sane default. */
export async function guardedCheckbox(opts: CheckboxConfig & GuardedCheckboxOptions): Promise<string[]> {
  const { flagName, nonInteractiveDefault, ...rest } = opts;
  if (isNonInteractive()) {
    if (nonInteractiveDefault !== undefined) return nonInteractiveDefault;
    throw new UsageError(`Missing required value: pass ${flagName} (non-interactive mode)`);
  }
  return checkbox(rest);
}
