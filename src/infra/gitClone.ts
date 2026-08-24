import { execFile } from 'child_process';

export interface RunGitCloneOptions {
  /** When set, overrides the child process's environment (used to attach
   * `GIT_SSH_COMMAND` for a keyed ssh clone) — omitted entirely for a
   * plain clone (https/git:// or a keyless identity), matching the real
   * `git clone` a user would run by hand. */
  env?: NodeJS.ProcessEnv;
  /** True in interactive (rich-TTY, non-JSON) mode: git's own stderr
   * progress is relayed live to this process's stderr. False in JSON/PLAIN
   * mode, where nothing is printed live — the captured text is used only to
   * build a failure's stderr tail. */
  interactive: boolean;
}

/** Thrown when `git clone` itself exits non-zero. Carries the last few
 * non-empty lines of git's own stderr so `dss clone`'s fail() message has
 * something actionable to show, even in JSON/PLAIN mode where nothing was
 * printed live. */
export class GitCloneError extends Error {
  readonly stderrTail: string;
  constructor(message: string, stderrTail: string) {
    super(message);
    this.name = 'GitCloneError';
    this.stderrTail = stderrTail;
  }
}

const MAX_BUFFER = 20 * 1024 * 1024;
const TAIL_LINES = 10;

function tail(text: string, lines: number = TAIL_LINES): string {
  return text
    .split('\n')
    .filter(line => line.trim().length > 0)
    .slice(-lines)
    .join('\n');
}

/**
 * Runs `git clone <url> <dest>` via `execFile` — never a shell, and never
 * `spawn` (the brief requires `execFile` only). Node's own `execFile`
 * implementation always pipes stdout/stderr internally to build its
 * callback's buffered output — it does not honor a caller-supplied `stdio`
 * option the way `spawn` does — so "inherit stderr in interactive mode" is
 * achieved by piping the `ChildProcess` it returns (`execFile` returns one
 * synchronously, same as `spawn`) to `process.stderr` ourselves, on top of
 * (not instead of) execFile's own internal capture. That capture is what
 * lets a failed clone's error carry a stderr tail in EITHER mode.
 */
export function runGitClone(url: string, dest: string, options: RunGitCloneOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const execOptions: { env?: NodeJS.ProcessEnv; maxBuffer: number } = { maxBuffer: MAX_BUFFER };
    if (options.env) execOptions.env = options.env;

    const child = execFile('git', ['clone', url, dest], execOptions, (error, _stdout, stderr) => {
      if (error) {
        reject(new GitCloneError(`git clone failed: ${tail(String(stderr ?? ''))}`, tail(String(stderr ?? ''))));
        return;
      }
      resolve();
    });

    if (options.interactive) {
      child.stderr?.pipe(process.stderr);
    }
  });
}
