import chalk from 'chalk';
import { performance } from 'perf_hooks';
import { isJsonMode } from './jsonOutput';

// The calm output voice (Phase 3 · Task 1): one accent (cyan), a small
// glyph set instead of emoji, no box-drawing, and a PLAIN degrade for
// NO_COLOR / non-TTY output so piped/CI output stays greppable ASCII.
const GLYPH = {
  active: '●',   // accent — the active/current identity marker
  success: '✓',
  error: '✗',
  warning: '!',
  bullet: '·',
} as const;

/**
 * Whether output should degrade to plain ASCII: no ANSI color, no Unicode
 * glyphs, no box-drawing characters. Respects `NO_COLOR` even on a TTY, and
 * defaults to plain whenever stdout isn't a TTY (e.g. piped to `cat`).
 *
 * Deliberately re-evaluated on every call (not cached at module load) so
 * NO_COLOR/TTY state can change between calls in the same process — which
 * is also what lets tests exercise both PLAIN and rich rendering.
 */
function isPlainMode(): boolean {
  return !!process.env.NO_COLOR || !process.stdout.isTTY;
}

export class UIHelper {
  static isPlain(): boolean {
    return isPlainMode();
  }

  /**
   * Every decorative/status write to stdout — inside UIHelper and out —
   * routes through here (or `write`, for the spinner's raw
   * `process.stdout.write` calls) so `--json` mode's "exactly one JSON
   * object on stdout, nothing else" guarantee holds regardless of which
   * command or renderer produced the line. A no-op in JSON mode; otherwise
   * `console.log(text)`. Public so command modules with their own raw
   * `console.log` calls (a public-key dump, a repo listing, ...) can route
   * through the same guard instead of duplicating the isJsonMode() check.
   */
  static print(text: string = ''): void {
    if (isJsonMode()) return;
    console.log(text);
  }

  /** JSON-mode-guarded `process.stdout.write` — see `print`'s note. Used by
   * the progress spinner, which writes partial lines (`\r...`) that
   * `print`'s trailing newline would break. */
  private static write(text: string): void {
    if (isJsonMode()) return;
    process.stdout.write(text);
  }

  /**
   * Swaps decorative glyphs (`·`, `—`) for a plain ASCII dash when in PLAIN
   * mode; a no-op otherwise. Applied wherever a string that might carry one
   * of these glyphs reaches the terminal, so PLAIN output never leaks rich
   * punctuation regardless of which renderer composed the string.
   */
  static plainify(text: string): string {
    return this.isPlain() ? text.replace(/[·—]/g, '-') : text;
  }

  /** The list/separator bullet: `·` in rich mode, `-` in PLAIN. */
  static bullet(): string {
    return this.isPlain() ? '-' : GLYPH.bullet;
  }

  private static style(colorFn: (s: string) => string, text: string): string {
    return this.isPlain() ? this.plainify(text) : colorFn(text);
  }

  static success(message: string): void {
    this.print(this.isPlain() ? this.plainify(message) : chalk.green(`${GLYPH.success} ${message}`));
  }

  static error(message: string): void {
    this.print(this.isPlain() ? `error: ${this.plainify(message)}` : chalk.red(`${GLYPH.error} ${message}`));
  }

  static warning(message: string): void {
    this.print(this.isPlain() ? `warn: ${this.plainify(message)}` : chalk.yellow(`${GLYPH.warning} ${message}`));
  }

  static info(message: string): void {
    this.print(this.isPlain() ? this.plainify(message) : chalk.dim(message));
  }

  static highlight(text: string): string {
    return this.style(chalk.cyan, text);
  }

  static dim(text: string): string {
    return this.style(chalk.dim, text);
  }

  static bold(text: string): string {
    return this.style(chalk.bold, text);
  }

  static activeSpace(name: string): string {
    return this.isPlain() ? `* ${name}` : chalk.cyan(`${GLYPH.active} ${name}`);
  }

  static inactiveSpace(name: string): string {
    return name;
  }

  static spaceName(name: string, isActive: boolean = false): string {
    return isActive ? this.activeSpace(name) : this.inactiveSpace(name);
  }

  /**
   * The `dss prompt` segment line: `● name` (rich, accent cyan) or bare
   * `name` (PLAIN — no glyph, no color, and deliberately NOT the `* name`
   * fallback `activeSpace` uses elsewhere: a shell-prompt segment must
   * degrade to the plainest possible token, not a decorative substitute).
   * `sourceLabel` (already resolved to "repo"/"rule"/"global" by the
   * caller) is appended as a dim ` (label)` suffix in rich mode, or a bare
   * ` (label)` suffix in PLAIN mode — only when passed at all, since the
   * `--source` hint is opt-in.
   */
  static promptSegment(name: string, sourceLabel?: string): string {
    const suffix = sourceLabel ? ` (${sourceLabel})` : '';
    if (this.isPlain()) {
      return `${name}${suffix}`;
    }
    return chalk.cyan(`${GLYPH.active} ${name}`) + (suffix ? chalk.dim(suffix) : '');
  }

  static command(cmd: string): string {
    return this.style(chalk.cyan, `\`${cmd}\``);
  }

  static filename(path: string): string {
    return this.style(chalk.dim, path);
  }

  static url(url: string): string {
    return this.isPlain() ? url : chalk.cyan.underline(url);
  }

  /** A dim hairline rule `width` characters wide. No-op in PLAIN mode. */
  static printSeparator(width?: number): void {
    if (this.isPlain()) return;
    const terminalWidth = process.stdout.columns || 80;
    const lineWidth = Math.min(width ?? 60, terminalWidth - 4);
    this.print(chalk.dim('─'.repeat(Math.max(0, lineWidth))));
  }

  /**
   * A calm section header: a single bold/accent line, optionally followed
   * by a dim hairline the width of the title. No box-drawing.
   */
  static printHeader(title: string): void {
    if (this.isPlain()) {
      this.print(title);
      return;
    }
    this.print(chalk.bold.cyan(title));
    this.printSeparator(title.length);
  }

  // Helper function to get string length without ANSI escape codes
  private static getDisplayLength(str: string): number {
    // Remove ANSI escape codes to get actual display length
    // eslint-disable-next-line no-control-regex
    return str.replace(/\u001b\[[0-9;]*m/g, '').length;
  }

  // Helper function to pad string accounting for ANSI escape codes
  private static padWithColors(str: string, targetLength: number): string {
    const displayLength = this.getDisplayLength(str);
    const padding = Math.max(0, targetLength - displayLength);
    return str + ' '.repeat(padding);
  }

  static printSpaceTable(spaces: Array<{ name: string; email: string; userName: string; sshKeyPath: string; host?: string }>, activeSpace?: string): void {
    if (spaces.length === 0) {
      this.warning('No identities yet.');
      return;
    }

    const host = (s: { host?: string }) => s.host ?? 'github.com';
    const status = (s: { name: string }) => (s.name === activeSpace ? 'active' : 'inactive');

    if (this.isPlain()) {
      // No box-drawing, no color: a simple tab-separated table that pipes cleanly.
      this.print(['Name', 'Email', 'User', 'Host', 'Status'].join('\t'));
      spaces.forEach(space => {
        const name = space.name === activeSpace ? `* ${space.name}` : space.name;
        this.print([name, space.email, space.userName, host(space), status(space)].join('\t'));
      });
      return;
    }

    const nameWidth = Math.max(4, ...spaces.map(s => s.name.length + (s.name === activeSpace ? 2 : 0)));
    const emailWidth = Math.max(5, ...spaces.map(s => s.email.length));
    const userWidth = Math.max(4, ...spaces.map(s => s.userName.length));
    const hostWidth = Math.max(4, ...spaces.map(s => host(s).length));

    const header = [
      this.padWithColors(chalk.bold('Name'), nameWidth),
      this.padWithColors(chalk.bold('Email'), emailWidth),
      this.padWithColors(chalk.bold('User'), userWidth),
      this.padWithColors(chalk.bold('Host'), hostWidth),
      chalk.bold('Status'),
    ].join('  ');
    this.print(header);
    this.printSeparator(nameWidth + emailWidth + userWidth + hostWidth + 6 + 8);

    spaces.forEach(space => {
      const isActive = space.name === activeSpace;
      const nameCell = isActive ? this.activeSpace(space.name) : space.name;
      const statusCell = isActive ? chalk.cyan('active') : chalk.dim('inactive');

      const row = [
        this.padWithColors(nameCell, nameWidth),
        this.padWithColors(chalk.dim(space.email), emailWidth),
        this.padWithColors(chalk.dim(space.userName), userWidth),
        this.padWithColors(chalk.dim(host(space)), hostWidth),
        statusCell,
      ].join('  ');
      this.print(row);
    });
  }

  static printRuleTable(rules: Array<{ dir: string; identity: string }>): void {
    if (rules.length === 0) {
      this.warning('No directory rules yet.');
      return;
    }

    if (this.isPlain()) {
      this.print(['Directory', 'Identity'].join('\t'));
      rules.forEach(rule => this.print([rule.dir, rule.identity].join('\t')));
      return;
    }

    const dirWidth = Math.max(9, ...rules.map(rule => rule.dir.length));
    this.print(this.padWithColors(chalk.bold('Directory'), dirWidth) + '  ' + chalk.bold('Identity'));
    this.printSeparator(dirWidth + 2 + 8);
    rules.forEach(rule => {
      this.print(this.padWithColors(chalk.dim(rule.dir), dirWidth) + '  ' + this.highlight(rule.identity));
    });
  }

  private static progressState = {
    active: false,
    startTime: 0,
    message: '',
    spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧'],
    index: 0,
    interval: null as NodeJS.Timeout | null
  };

  static printProgress(message: string): void {
    this.clearProgress();

    if (this.isPlain()) {
      // No animation off a TTY — a single static line instead of a spinner.
      this.print(`${message}...`);
      return;
    }

    this.progressState.active = true;
    this.progressState.startTime = performance.now();
    this.progressState.message = message;
    this.progressState.index = 0;

    const updateSpinner = () => {
      if (!this.progressState.active) return;

      const elapsed = Math.floor((performance.now() - this.progressState.startTime) / 1000);
      const spinner = this.progressState.spinner[this.progressState.index % this.progressState.spinner.length];
      const timeStr = elapsed > 0 ? ` (${elapsed}s)` : '';

      this.write(`\r${chalk.cyan(spinner)} ${this.progressState.message}...${chalk.dim(timeStr)}`);
      this.progressState.index++;
    };

    updateSpinner();
    this.progressState.interval = setInterval(updateSpinner, 80);
  }

  static clearProgress(): void {
    if (this.progressState.interval) {
      clearInterval(this.progressState.interval);
      this.progressState.interval = null;
    }
    this.progressState.active = false;

    if (this.isPlain()) return; // nothing was drawn to erase

    const terminalWidth = process.stdout.columns || 80;
    this.write('\r' + ' '.repeat(terminalWidth) + '\r');
  }

  static updateProgress(message: string): void {
    if (this.progressState.active) {
      this.progressState.message = message;
    }
  }

  /**
   * A one-line summary (success/error/info) plus dim, indented detail
   * lines — the calm replacement for the old bordered boxes. Blank lines
   * in `content` (formerly used as box spacers) are dropped, and a stray
   * leading glyph left over in a content string is stripped so it doesn't
   * duplicate the bullet this renders.
   */
  private static renderSummary(kind: 'success' | 'error' | 'info', title: string, content: string[]): void {
    if (kind === 'success') this.success(title);
    else if (kind === 'error') this.error(title);
    else this.info(title);

    content
      .map(line => line.replace(/^\s*[✓✗!⚠]\s*/, '').trim())
      .filter(line => line.length > 0)
      .forEach(line => {
        this.print(this.isPlain() ? `  - ${this.plainify(line)}` : chalk.dim(`  ${GLYPH.bullet} ${line}`));
      });
  }

  static printSuccessBox(title: string, content: string[]): void {
    this.renderSummary('success', title, content);
  }

  static printErrorBox(title: string, content: string[]): void {
    this.renderSummary('error', title, content);
  }

  static printInfoBox(title: string, content: string[]): void {
    this.renderSummary('info', title, content);
  }

  static printStatus(label: string, value: string, status: 'success' | 'error' | 'warning' | 'info' = 'info'): void {
    const glyphByStatus = {
      success: GLYPH.success,
      error: GLYPH.error,
      warning: GLYPH.warning,
      info: '',
    };
    const colorByStatus = {
      success: chalk.green,
      error: chalk.red,
      warning: chalk.yellow,
      info: chalk.dim,
    };
    const plainTagByStatus = {
      success: '',
      error: 'error: ',
      warning: 'warn: ',
      info: '',
    };

    if (this.isPlain()) {
      this.print(`${plainTagByStatus[status]}${this.plainify(label)}: ${this.plainify(value)}`);
      return;
    }

    const glyph = glyphByStatus[status];
    const prefix = glyph ? `${colorByStatus[status](glyph)} ` : '';
    this.print(`${prefix}${chalk.bold(label)}: ${value}`);
  }

  /**
   * A short glyph-prefixed fragment (not a full label: value line) for
   * composing several checks onto one compact line — e.g. the bare-`dss`
   * dashboard's health line (`✓ key ed25519   ✓ agent loaded`). PLAIN mode
   * drops the Unicode glyph in favor of the same "error: "/"warn: " text
   * tags printStatus uses, so a success fragment is bare text.
   */
  static statusFragment(status: 'success' | 'error' | 'warning', text: string): string {
    if (this.isPlain()) {
      const tag = status === 'error' ? 'error: ' : status === 'warning' ? 'warn: ' : '';
      return `${tag}${this.plainify(text)}`;
    }
    const glyph = status === 'success' ? GLYPH.success : status === 'error' ? GLYPH.error : GLYPH.warning;
    const colorFn = status === 'success' ? chalk.green : status === 'error' ? chalk.red : chalk.yellow;
    return colorFn(`${glyph} ${text}`);
  }

  /**
   * The product-name banner for the first-run/dashboard front door: a
   * calm bold/accent name line plus a dim tagline. No box-drawing (the old
   * ╭═╮ banner is gone) — same shape as printHeader, just two lines.
   */
  static printWelcome(): void {
    if (this.isPlain()) {
      this.print('Dev Spaces Switcher');
      this.print('Manage isolated development environments with ease');
      return;
    }
    this.print(chalk.bold.cyan('Dev Spaces Switcher'));
    this.print(chalk.dim('Manage isolated development environments with ease'));
  }

  /** A calm, one-line "switched" success — the frameless replacement for
   * the old bordered "Space Switched Successfully!" box. */
  static printSpaceSwitched(spaceName: string): void {
    this.success(`Switched to ${spaceName}`);
  }
}
