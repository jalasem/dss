import { IConfig } from '../core/types';
import { loadConfig } from '../infra/store';
import { UIHelper } from './ui';
import { guardedConfirm } from './prompts';
// Circular import: ./spaces imports firstRunFlow from this file too (for
// its own empty-store branches). This only resolves safely under CommonJS
// because `addSpace` is used exclusively inside firstRunFlow's async body
// below, not at module scope — by the time firstRunFlow actually runs,
// both modules have finished loading and spaces.ts's exports are fully
// populated. Keep every use of `addSpace` (and, symmetrically, every use
// of `firstRunFlow` on the spaces.ts side) inside a function body; a
// module-scope reference to either export here would break on load order.
import { addSpace } from './spaces';

/**
 * The automatic first-run flow: replaces the old `dss onboard` tutorial.
 * Triggered by a caller (currently `dss ls` / `dss use` when the store has
 * zero identities; Task 3's bare-`dss` dashboard will call it too) rather
 * than being its own command. Prints a short calm welcome and offers to
 * create the first identity right away — no multi-step tutorial.
 *
 * Self-contained: loads its own config unless the caller already has one
 * (avoids a redundant loadConfig() when the caller just checked
 * `config.spaces.length` itself), and makes no assumption about being
 * called from only one place.
 *
 * Returns true when the flow ran (the store was empty), false otherwise —
 * callers use this to decide whether to fall through to their normal
 * behavior.
 */
export async function firstRunFlow(config?: IConfig): Promise<boolean> {
  const resolvedConfig = config ?? (await loadConfig()).config;
  if (resolvedConfig.spaces.length > 0) return false;

  UIHelper.printWelcome();
  UIHelper.print('');

  // Optional/informational: triggered automatically (not a command the
  // caller explicitly ran), so non-interactive mode without -y silently
  // declines instead of erroring — a script running `dss ls`/`dss use`
  // against an empty store shouldn't be blocked here.
  const shouldCreate = await guardedConfirm({
    message: 'No identities yet — create your first one now?',
    default: true,
    optional: true,
  });

  if (shouldCreate) {
    await addSpace();
  } else {
    UIHelper.info('Use ' + UIHelper.command('dss new') + ' anytime to create your first identity.');
  }

  return true;
}
