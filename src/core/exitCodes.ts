// The CLI's exit-code contract (Phase 4 · Task 2): every path DSS can
// terminate through — success, an operational failure, a malformed/missing
// invocation, or a cancelled prompt — settles on exactly one of these four
// codes. Used at every process.exitCode/process.exit assignment site and by
// the Commander exitOverride mapping in src/commands/errorHandling.ts,
// instead of the magic numbers those sites used before.
export const EXIT_CODES = {
  OK: 0,
  FAILURE: 1,
  USAGE: 2,
  CANCELLED: 130
} as const;

export type ExitCode = typeof EXIT_CODES[keyof typeof EXIT_CODES];
