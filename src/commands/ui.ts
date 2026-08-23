import chalk from 'chalk';
import { performance } from 'perf_hooks';

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
    console.log(this.isPlain() ? this.plainify(message) : chalk.green(`${GLYPH.success} ${message}`));
  }

  static error(message: string): void {
    console.log(this.isPlain() ? `error: ${this.plainify(message)}` : chalk.red(`${GLYPH.error} ${message}`));
  }

  static warning(message: string): void {
    console.log(this.isPlain() ? `warn: ${this.plainify(message)}` : chalk.yellow(`${GLYPH.warning} ${message}`));
  }

  static info(message: string): void {
    console.log(this.isPlain() ? this.plainify(message) : chalk.dim(message));
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
    console.log(chalk.dim('─'.repeat(Math.max(0, lineWidth))));
  }

  /**
   * A calm section header: a single bold/accent line, optionally followed
   * by a dim hairline the width of the title. No box-drawing.
   */
  static printHeader(title: string): void {
    if (this.isPlain()) {
      console.log(title);
      return;
    }
    console.log(chalk.bold.cyan(title));
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
      console.log(['Name', 'Email', 'User', 'Host', 'Status'].join('\t'));
      spaces.forEach(space => {
        const name = space.name === activeSpace ? `* ${space.name}` : space.name;
        console.log([name, space.email, space.userName, host(space), status(space)].join('\t'));
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
    console.log(header);
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
      console.log(row);
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
      console.log(`${message}...`);
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

      process.stdout.write(`\r${chalk.cyan(spinner)} ${this.progressState.message}...${chalk.dim(timeStr)}`);
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
    process.stdout.write('\r' + ' '.repeat(terminalWidth) + '\r');
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
        console.log(this.isPlain() ? `  - ${this.plainify(line)}` : chalk.dim(`  ${GLYPH.bullet} ${line}`));
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
      console.log(`${plainTagByStatus[status]}${this.plainify(label)}: ${this.plainify(value)}`);
      return;
    }

    const glyph = glyphByStatus[status];
    const prefix = glyph ? `${colorByStatus[status](glyph)} ` : '';
    console.log(`${prefix}${chalk.bold(label)}: ${value}`);
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
      console.log('Dev Spaces Switcher');
      console.log('Manage isolated development environments with ease');
      return;
    }
    console.log(chalk.bold.cyan('Dev Spaces Switcher'));
    console.log(chalk.dim('Manage isolated development environments with ease'));
  }

  /** A calm, one-line "switched" success — the frameless replacement for
   * the old bordered "Space Switched Successfully!" box. */
  static printSpaceSwitched(spaceName: string): void {
    this.success(`Switched to ${spaceName}`);
  }
}
