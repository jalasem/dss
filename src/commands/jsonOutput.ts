// Phase 4 · Task 3 — global `--json`: the single seam every command's JSON
// payload flows through. With `--json`, a DSS invocation must emit EXACTLY
// ONE JSON object to stdout and nothing else on stdout (decorative/status
// output from UIHelper, and every raw console.log a command makes, is
// suppressed on stdout in JSON mode instead — see ui.ts's isJsonMode guard).
//
// State is module-level (matches setAssumeYes's pattern in prompts.ts): one
// CLI invocation is one process, so a single mutable "pending result" is
// simpler than threading a context object through every command signature.
// `_resetJsonStateForTests` exists solely so unit tests (running in one
// long-lived Jest process) can isolate cases from each other; production
// code never calls it.

let jsonModeOn = false;
let commandName = '';
let pendingData: Record<string, unknown> = {};
let firstErrorMessage: string | undefined;
let alreadyFlushed = false;

/**
 * Turns on JSON mode (idempotent) and records/updates the primary command
 * name reported in the eventual `{ok, command, ...}` object. Called once
 * from the global `--json` option handler (with a placeholder name — the
 * command isn't resolved yet at that point) and again from index.ts's
 * preAction hook once Commander has resolved the actual command (aliases
 * report their PRIMARY name there, not the alias they were invoked as).
 */
export function setJsonMode(command: string): void {
  jsonModeOn = true;
  commandName = command;
}

export function isJsonMode(): boolean {
  return jsonModeOn;
}

/** Merges `patch` into the pending success payload's `data` object. */
export function jsonData(patch: object): void {
  Object.assign(pendingData, patch);
}

/** Records the FIRST failure message only — later calls (a second fail(),
 * a later thrown error, ...) are no-ops so `error.message` always reflects
 * the failure that mattered, not whatever printed last. */
export function jsonFail(message: string): void {
  if (firstErrorMessage === undefined) firstErrorMessage = message;
}

/**
 * Emits the single JSON object to stdout. Idempotent — every call after
 * the first is a no-op, and a no-op entirely when JSON mode was never
 * turned on — so it's safe to call from both the normal end of the parse
 * chain AND every top-level error path without risking a second object
 * (or any output at all) when `--json` wasn't passed.
 */
export function flushJson(): void {
  if (!jsonModeOn || alreadyFlushed) return;
  alreadyFlushed = true;

  const payload = firstErrorMessage !== undefined
    ? { ok: false, command: commandName, error: { message: firstErrorMessage } }
    : { ok: true, command: commandName, data: pendingData };

  process.stdout.write(JSON.stringify(payload) + '\n');
}

/** Test-only: resets all module state between cases in the same process. */
export function _resetJsonStateForTests(): void {
  jsonModeOn = false;
  commandName = '';
  pendingData = {};
  firstErrorMessage = undefined;
  alreadyFlushed = false;
}
