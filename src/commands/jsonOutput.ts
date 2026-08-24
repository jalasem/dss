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
let capturedCommanderOutput = '';

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

/**
 * REPLACES the pending success payload's `data` object wholesale (unlike
 * `jsonData`'s merge). For a command whose handler makes an internal call
 * into another command's own handler as part of its normal flow (`new`
 * optionally calling `use`'s `switchSpace`) — that inner call merges its
 * OWN jsonData() patch into the same pending object, polluting the outer
 * command's payload with foreign keys. The outer command calls
 * `jsonSetData` LAST, once its own full payload is assembled, to guarantee
 * its object's key set is exactly what it documents — regardless of what
 * any inner call merged in along the way.
 */
export function jsonSetData(data: object): void {
  pendingData = { ...data };
}

/**
 * Captures text Commander itself would otherwise print directly (its own
 * `--help`/`--version` output, via `program.configureOutput()`'s `writeOut`
 * in index.ts) instead of letting it reach stdout — in JSON mode, that text
 * becomes `data.help`/`data.version` on the single JSON object instead
 * (see errorHandling.ts's CommanderError handling). Appends, since
 * Commander may call `writeOut` more than once for a single help render.
 */
export function captureCommanderOutput(text: string): void {
  capturedCommanderOutput += text;
}

/** Returns and clears the buffer captured by `captureCommanderOutput`. */
export function takeCommanderOutput(): string {
  const text = capturedCommanderOutput;
  capturedCommanderOutput = '';
  return text;
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
 *
 * `ok` is derived from `process.exitCode` AT FLUSH TIME — `(process.exitCode
 * ?? 0) === 0` — not merely from whether jsonFail() was ever called. Some
 * paths (doctor's hard-failure summary, a recursive `link`'s partial
 * failure) set `process.exitCode` directly without going through fail()/
 * jsonFail() — deriving `ok` from the exit code, the CLI's own single
 * source of truth for success/failure, is what keeps the Task-2 exit-code
 * contract and `--json`'s `ok` field from ever disagreeing. Every caller
 * that sets `process.exitCode` for a JSON-mode invocation MUST do so
 * BEFORE calling flushJson() (see errorHandling.ts's ordering) — flushJson
 * itself can't retroactively see a later assignment.
 *
 * When `ok` comes out false and nothing ever called jsonFail() with a
 * specific message (the two paths above), the error object still needs
 * SOME message — falls back to the generic "command failed" rather than
 * silently omitting `error.message`.
 *
 * A failure does NOT discard whatever `data` the command had already
 * assembled before it failed (review finding #2): doctor's hard-failure
 * summary (checks[]/summary) and a recursive `link`'s partial-failure
 * summary (bound[]/failed[]) are exactly the payloads AGENTS.md documents
 * as useful for failure analysis — dropping them just because `ok` came out
 * false threw that analysis away. So the failure payload includes `data`
 * ALONGSIDE `error` whenever anything was ever merged into it via
 * jsonData()/jsonSetData(), giving `{ok:false, command, error, data}`; a
 * failure that produced no data at all (most of them — a plain not-found,
 * a Commander usage error) keeps the leaner `{ok:false, command, error}`
 * shape unchanged.
 */
export function flushJson(): void {
  if (!jsonModeOn || alreadyFlushed) return;
  alreadyFlushed = true;

  const ok = (process.exitCode ?? 0) === 0;
  const payload: Record<string, unknown> = ok
    ? { ok: true, command: commandName, data: pendingData }
    : { ok: false, command: commandName, error: { message: firstErrorMessage ?? 'command failed' } };

  if (!ok && Object.keys(pendingData).length > 0) {
    payload.data = pendingData;
  }

  process.stdout.write(JSON.stringify(payload) + '\n');
}

/** Test-only: resets all module state between cases in the same process. */
export function _resetJsonStateForTests(): void {
  jsonModeOn = false;
  commandName = '';
  pendingData = {};
  firstErrorMessage = undefined;
  alreadyFlushed = false;
  capturedCommanderOutput = '';
}
