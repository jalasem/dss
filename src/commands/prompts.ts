import { confirm, password, select, input } from '@inquirer/prompts';
import { KNOWN_HOSTS } from '../core/hosts';

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

function validateCustomHost(value: string): string | true {
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
