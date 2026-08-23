import { confirm, password } from '@inquirer/prompts';

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
