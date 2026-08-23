import { confirm } from '@inquirer/prompts';

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
