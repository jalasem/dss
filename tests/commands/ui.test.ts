import chalk from 'chalk';
import { UIHelper } from '../../src/commands/ui';

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\[[0-9;]*m/;
const BOX_CHARS = /[┌┬┐├┼┤└┴┘╭╮╰╯╔╗╠╣╚╝║]/;
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

/**
 * Jest runs with a non-TTY stdout, so UIHelper is already in PLAIN mode by
 * default — that's the same "piped" state real CI/`| cat` usage hits. These
 * helpers flip stdout.isTTY / NO_COLOR to exercise the rich-mode branch too.
 */
function withRichMode(fn: () => void): void {
  const originalIsTTY = process.stdout.isTTY;
  const originalNoColor = process.env.NO_COLOR;
  const originalChalkLevel = chalk.level;
  (process.stdout as any).isTTY = true;
  delete process.env.NO_COLOR;
  // chalk's own color-support level is detected once (at import, when
  // Jest's stdout isn't a TTY) and isn't re-derived when isTTY flips later
  // in a test, so force it on here — this exercises UIHelper's non-PLAIN
  // rendering branch the same way a real interactive terminal would.
  chalk.level = 3;
  try {
    fn();
  } finally {
    (process.stdout as any).isTTY = originalIsTTY;
    chalk.level = originalChalkLevel;
    if (originalNoColor !== undefined) process.env.NO_COLOR = originalNoColor;
  }
}

function withPlainModeViaNoColor(fn: () => void): void {
  const originalIsTTY = process.stdout.isTTY;
  const originalNoColor = process.env.NO_COLOR;
  (process.stdout as any).isTTY = true;
  process.env.NO_COLOR = '1';
  try {
    fn();
  } finally {
    (process.stdout as any).isTTY = originalIsTTY;
    if (originalNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = originalNoColor;
  }
}

function loggedLines(): string[] {
  return (console.log as jest.Mock).mock.calls.flat().filter((v): v is string => typeof v === 'string');
}

describe('UIHelper', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should create colored output', () => {
    UIHelper.success('Test message');
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Test message'));
  });

  it('should create error output', () => {
    UIHelper.error('Error message');
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Error message'));
  });

  it('should create warning output', () => {
    UIHelper.warning('Warning message');
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Warning message'));
  });

  it('should create info output', () => {
    UIHelper.info('Info message');
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Info message'));
  });

  it('should highlight text', () => {
    const result = UIHelper.highlight('test');
    expect(result).toContain('test');
  });

  it('should format command text', () => {
    const result = UIHelper.command('dss add');
    expect(result).toContain('dss add');
  });

  it('should format filename text', () => {
    const result = UIHelper.filename('/path/to/file');
    expect(result).toContain('/path/to/file');
  });

  it('should format URL text', () => {
    const result = UIHelper.url('https://example.com');
    expect(result).toContain('https://example.com');
  });

  describe('PLAIN mode (non-TTY / NO_COLOR)', () => {
    it('is the default under Jest (non-TTY stdout)', () => {
      expect(UIHelper.isPlain()).toBe(true);
    });

    it('strips ANSI color, glyphs, and box chars from success/error/warning', () => {
      UIHelper.success('ok done');
      UIHelper.error('bad thing');
      UIHelper.warning('careful');

      for (const line of loggedLines()) {
        expect(line).not.toMatch(ANSI_RE);
        expect(line).not.toMatch(/[✓✗!●·]/);
        expect(line).not.toMatch(BOX_CHARS);
        expect(line).not.toMatch(EMOJI_RE);
        expect(line).not.toContain('[');
      }
    });

    it('degrades error/warning to greppable ASCII tags', () => {
      UIHelper.error('bad thing');
      UIHelper.warning('careful');
      const lines = loggedLines();
      expect(lines.some(l => l === 'error: bad thing')).toBe(true);
      expect(lines.some(l => l === 'warn: careful')).toBe(true);
    });

    it('degrades the active-space glyph (●) to a plain "*"', () => {
      const result = UIHelper.activeSpace('work');
      expect(result).toBe('* work');
      expect(result).not.toMatch(ANSI_RE);
      expect(result).not.toContain('●');
    });

    it('respects NO_COLOR even when stdout is a TTY', () => {
      withPlainModeViaNoColor(() => {
        expect(UIHelper.isPlain()).toBe(true);
        const result = UIHelper.activeSpace('work');
        expect(result).toBe('* work');
        expect(result).not.toMatch(ANSI_RE);
      });
    });

    it('printSuccessBox/printErrorBox/printInfoBox emit no box-drawing frame characters', () => {
      UIHelper.printSuccessBox('Space Activated', ['Switched to: work', 'Git user: Alice']);
      UIHelper.printErrorBox('Something Failed', ['Detail one', 'Detail two']);
      UIHelper.printInfoBox('Heads Up', ['Note one']);

      for (const line of loggedLines()) {
        expect(line).not.toMatch(BOX_CHARS);
        expect(line).not.toMatch(/[╭╮╰╯╔╗╠╣╚╝]/);
      }
    });

    it('printHeader emits no box-drawing frame characters', () => {
      UIHelper.printHeader('Your Development Spaces');
      for (const line of loggedLines()) {
        expect(line).not.toMatch(BOX_CHARS);
      }
    });

    it('printSpaceTable emits a tab-separated table with no box-drawing characters', () => {
      UIHelper.printSpaceTable(
        [{ name: 'work', email: 'w@x.com', userName: 'W', sshKeyPath: '/k', host: 'gitlab.com' }],
        'work'
      );
      const lines = loggedLines();
      expect(lines.some(l => l.includes('Host'))).toBe(true);
      expect(lines.some(l => l.includes('gitlab.com'))).toBe(true);
      for (const line of lines) {
        expect(line).not.toMatch(BOX_CHARS);
        expect(line).not.toMatch(ANSI_RE);
      }
    });

    it('printWelcome degrades to a plain name + tagline, no box/glyphs/ANSI', () => {
      UIHelper.printWelcome();
      const lines = loggedLines();
      expect(lines.some(l => l.includes('Dev Spaces Switcher'))).toBe(true);
      expect(lines.some(l => /manage isolated development environments/i.test(l))).toBe(true);
      for (const line of lines) {
        expect(line).not.toMatch(BOX_CHARS);
        expect(line).not.toMatch(ANSI_RE);
        expect(line).not.toMatch(EMOJI_RE);
      }
    });

    it('printSpaceSwitched degrades to a bare one-line message, no box/glyphs/ANSI', () => {
      UIHelper.printSpaceSwitched('work');
      expect(console.log).toHaveBeenCalledTimes(1);
      const [line] = (console.log as jest.Mock).mock.calls[0];
      expect(line).toContain('work');
      expect(line).not.toMatch(ANSI_RE);
      expect(line).not.toMatch(BOX_CHARS);
      expect(line).not.toMatch(/[✓✗!●]/);
    });
  });

  describe('rich mode (TTY, no NO_COLOR): glyph + color mapping', () => {
    it('success() renders a single line with the ✓ glyph, in green, no box chars', () => {
      withRichMode(() => {
        UIHelper.success('Space activated');
        expect(console.log).toHaveBeenCalledTimes(1);
        const [line] = (console.log as jest.Mock).mock.calls[0];
        expect(line).toContain('✓');
        expect(line).toContain('Space activated');
        expect(line).toMatch(ANSI_RE);
        expect(line).not.toMatch(BOX_CHARS);
        // single-line: no embedded newline
        expect(line).not.toContain('\n');
      });
    });

    it('error() renders the ✗ glyph in red', () => {
      withRichMode(() => {
        UIHelper.error('Something broke');
        const [line] = (console.log as jest.Mock).mock.calls[0];
        expect(line).toContain('✗');
        expect(line).toMatch(ANSI_RE);
      });
    });

    it('warning() renders the ! glyph in yellow', () => {
      withRichMode(() => {
        UIHelper.warning('Watch out');
        const [line] = (console.log as jest.Mock).mock.calls[0];
        expect(line).toContain('!');
        expect(line).toMatch(ANSI_RE);
      });
    });

    it('info() has no leading glyph', () => {
      withRichMode(() => {
        UIHelper.info('Just so you know');
        const [line] = (console.log as jest.Mock).mock.calls[0];
        expect(line).not.toMatch(/^[✓✗!●]/);
      });
    });

    it('activeSpace() renders the ● glyph in the cyan accent', () => {
      withRichMode(() => {
        const result = UIHelper.activeSpace('work');
        expect(result).toContain('●');
        expect(result).toMatch(ANSI_RE);
      });
    });

    it('printSuccessBox renders one success line plus dim indented detail lines, no frame', () => {
      withRichMode(() => {
        UIHelper.printSuccessBox('Space Activated', ['Switched to: work', 'Git user: Alice']);
        const calls = (console.log as jest.Mock).mock.calls.map(c => c[0]);
        expect(calls[0]).toContain('✓');
        expect(calls[0]).toContain('Space Activated');
        expect(calls.slice(1).every(l => l.includes('Switched to: work') || l.includes('Git user: Alice'))).toBe(true);
        for (const line of calls) {
          expect(line).not.toMatch(BOX_CHARS);
        }
      });
    });

    it('printHeader renders a bold/accent line without a box frame', () => {
      withRichMode(() => {
        UIHelper.printHeader('Your Development Spaces');
        const calls = (console.log as jest.Mock).mock.calls.map(c => c[0]);
        expect(calls[0]).toContain('Your Development Spaces');
        for (const line of calls) {
          expect(line).not.toMatch(BOX_CHARS);
        }
      });
    });

    it('printWelcome renders a bold/accent name line + dim tagline, no box frame', () => {
      withRichMode(() => {
        UIHelper.printWelcome();
        const calls = (console.log as jest.Mock).mock.calls.map(c => c[0]);
        expect(calls[0]).toContain('Dev Spaces Switcher');
        expect(calls[0]).toMatch(ANSI_RE);
        expect(calls.some(l => /manage isolated development environments/i.test(l))).toBe(true);
        for (const line of calls) {
          expect(line).not.toMatch(BOX_CHARS);
        }
      });
    });

    it('printSpaceSwitched renders one calm ✓ success line, no box frame', () => {
      withRichMode(() => {
        UIHelper.printSpaceSwitched('work');
        expect(console.log).toHaveBeenCalledTimes(1);
        const [line] = (console.log as jest.Mock).mock.calls[0];
        expect(line).toContain('✓');
        expect(line).toContain('work');
        expect(line).toMatch(ANSI_RE);
        expect(line).not.toMatch(BOX_CHARS);
        expect(line).not.toContain('\n');
      });
    });

    it('statusFragment renders a glyph-prefixed, colored fragment for success/error/warning', () => {
      withRichMode(() => {
        const success = UIHelper.statusFragment('success', 'key ed25519');
        const error = UIHelper.statusFragment('error', 'key missing');
        const warning = UIHelper.statusFragment('warning', 'agent not loaded');

        expect(success).toContain('✓');
        expect(success).toContain('key ed25519');
        expect(success).toMatch(ANSI_RE);
        expect(error).toContain('✗');
        expect(error).toMatch(ANSI_RE);
        expect(warning).toContain('!');
        expect(warning).toMatch(ANSI_RE);
      });
    });
  });

  describe('statusFragment (PLAIN mode)', () => {
    it('degrades to greppable ASCII tags with no glyph/ANSI, matching printStatus\'s tag scheme', () => {
      const success = UIHelper.statusFragment('success', 'key ed25519');
      const error = UIHelper.statusFragment('error', 'key missing');
      const warning = UIHelper.statusFragment('warning', 'agent not loaded');

      expect(success).toBe('key ed25519');
      expect(error).toBe('error: key missing');
      expect(warning).toBe('warn: agent not loaded');
      for (const fragment of [success, error, warning]) {
        expect(fragment).not.toMatch(ANSI_RE);
        expect(fragment).not.toMatch(/[✓✗]/);
      }
    });
  });
});
