import { EXIT_CODES } from '../core/exitCodes';
import { loadStore } from '../infra/store';
import { resolveAppliesHere, AppliesHereSource } from '../infra/identityResolution';
import { UIHelper } from './ui';
import { jsonData } from './jsonOutput';

export interface PromptOptions {
  source?: boolean;
}

const SOURCE_LABELS: Record<Exclude<AppliesHereSource, null>, string> = {
  bound: 'repo',
  rule: 'rule',
  global: 'global',
};

/**
 * `dss prompt`: emits a single-line shell-prompt identity segment for the
 * CURRENT directory and exits — the ONE command tuned for "runs on every
 * shell prompt render" (starship/oh-my-zsh/bash; see README's "Shell
 * prompt integration" for copy-paste recipes). Resolution reuses the
 * shared `resolveAppliesHere` (Phase 5 · Task 3) — the exact same bound >
 * directory rule > global precedence the dashboard/doctor/guard already
 * use — so there's no second, slowly-drifting copy of that logic here.
 *
 * Deliberately NO cache (controller ruling, ledgered — see the Phase 5 ·
 * Task 4 brief): Node's own process-startup cost dominates the latency a
 * cache file would need to amortize away, so a cache buys nothing here
 * beyond complexity. The fast path IS the direct call below — one `git
 * rev-parse` when bound, a single store read otherwise, same cost the
 * dashboard already pays on every bare `dss`.
 *
 * THE NEVER-BREAK CONTRACT (deliberate, documented exception to this
 * CLI's exit-code contract — contrast with `fail()`/EXIT_CODES.FAILURE
 * used everywhere else): a prompt segment runs on EVERY command line a
 * user types, in every shell session. If it throws, hangs, or exits
 * nonzero, it degrades the user's ENTIRE shell, not just one `dss`
 * invocation — some prompt frameworks even surface a nonzero exit as its
 * own visible error, which is worse than the segment just being absent.
 * So the WHOLE body below is wrapped in a single try/catch: a corrupt or
 * unreadable store, a git failure, a filesystem error, or anything else
 * unexpected degrades to EMPTY rich/PLAIN output (or a best-effort
 * `{ identity: null, source: null }` in `--json`) and exit `0` — never
 * `fail()`'s exit `1`, and never an uncaught stack trace on stderr. This
 * is intentional; do not "fix" it to use fail() or let an error escape.
 * Also never prompts (nothing below can reach a guarded prompt call), so
 * there's no risk of hanging on stdin mid-render either.
 */
export async function promptSegment(options: PromptOptions = {}): Promise<void> {
  try {
    const store = await loadStore();
    const resolved = await resolveAppliesHere(process.cwd(), store);

    if (!resolved.identity || !resolved.source) {
      jsonData({ identity: null, source: null });
      return;
    }

    const sourceLabel = options.source ? SOURCE_LABELS[resolved.source] : undefined;
    UIHelper.print(UIHelper.promptSegment(resolved.identity.name, sourceLabel));
    jsonData({ identity: resolved.identity.name, source: resolved.source });
  } catch {
    // See the never-break contract in the doc comment above: swallow
    // literally everything, emit nothing (--json still gets a best-effort
    // null payload), and force exit 0 regardless of any earlier state.
    jsonData({ identity: null, source: null });
    process.exitCode = EXIT_CODES.OK;
  }
}
