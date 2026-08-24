import fs from 'fs';
import path from 'path';
import { buildProgram } from '../src/cli/program';
import {
  describeProgram,
  generateBashScript,
  generateZshScript,
  generateFishScript,
  flagTokens,
  globalFlagTokens,
  DescribedCommand,
  DescribedProgram,
} from '../src/commands/completion';
import { EXIT_CODES } from '../src/core/exitCodes';

// Guards the two docs artifacts this task ships (AGENTS.md, README.md's
// command/exit-code sections) against drifting from the REAL Commander
// program — the same walker (describeProgram) the three completion
// generators consume, so "does the walker know about X" and "did the docs
// keep up with X" are checked against a single source of truth instead of
// two hand-maintained lists slowly diverging from each other and from the
// code.

// The tracked file is actually named "README.MD" (all-caps extension) —
// harmless on macOS's case-insensitive filesystem, but `fs.readFileSync`
// needs the exact case on Linux (CI). `git ls-files | grep -i readme`
// confirms the real on-disk/tracked name.
const README_PATH = path.join(__dirname, '..', 'README.MD');
const AGENTS_PATH = path.join(__dirname, '..', 'AGENTS.md');

function readFile(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Slices out one Markdown section by its exact heading line, up to (but
 * not including) the next heading of the SAME OR SHALLOWER level — e.g.
 * "## Core Commands" runs through its "###" subsections and stops at the
 * next "##". Anchors the README-vs-walker matcher to the intended
 * table/section instead of scanning the whole file, per the brief. */
function section(markdown: string, heading: string): string {
  const lines = markdown.split('\n');
  const level = (heading.match(/^#+/) ?? ['##'])[0].length;
  const startIndex = lines.findIndex(line => line.trim() === heading);
  if (startIndex === -1) {
    throw new Error(`Heading not found in README.md: "${heading}"`);
  }
  let endIndex = lines.length;
  for (let i = startIndex + 1; i < lines.length; i++) {
    const match = lines[i].match(/^(#+)\s/);
    if (match && match[1].length <= level) {
      endIndex = i;
      break;
    }
  }
  return lines.slice(startIndex, endIndex).join('\n');
}

describe('docs drift', () => {
  let described: DescribedProgram;
  let nonHidden: DescribedCommand[];

  // Names cut entirely (no alias, no walker entry either) — a regression
  // here would mean one of them crept back into a generated script.
  const cutCommands = ['batch', 'bulk', 'onboard'];

  beforeAll(() => {
    const { program } = buildProgram();
    described = describeProgram(program);
    nonHidden = described.commands.filter(cmd => !cmd.hidden);
  });

  describe('walker vs completion scripts', () => {
    const generators: Array<[string, (d: DescribedProgram) => string]> = [
      ['bash', generateBashScript],
      ['zsh', generateZshScript],
      ['fish', generateFishScript],
    ];

    it.each(generators)('every non-hidden command name appears in the %s script', (_shell, generate) => {
      const script = generate(described);
      for (const cmd of nonHidden) {
        expect(script).toMatch(new RegExp(`\\b${escapeRegex(cmd.name)}\\b`));
      }
    });

    it.each(generators)('no cut command (batch/bulk/onboard) appears in the %s script', (_shell, generate) => {
      const script = generate(described);
      for (const cut of cutCommands) {
        expect(script).not.toMatch(new RegExp(`\\b${cut}\\b`));
      }
    });

    // Deliberately NOT asserted here: "no hidden alias name appears in the
    // script" as a blanket string-search. Several alias names collide with
    // unrelated real text a script legitimately contains — "export"/
    // "import" are also `config`'s own advertised subcommand names, and
    // "test" appears inside fish's own `test -f ...` builtin call in
    // `__dss_get_spaces`. completion.test.ts's own
    // "advertises doctor (not test/inspect)" case already covers the one
    // alias pair (test/inspect -> doctor) that's actually at risk of
    // resurfacing, with a regex anchored to the dss-subcommand usage
    // specifically rather than a blanket word match.
  });

  describe('walker vs README', () => {
    const readme = readFile(README_PATH);

    it('every non-hidden command name appears in README.md', () => {
      for (const cmd of nonHidden) {
        const pattern = new RegExp('`dss ' + escapeRegex(cmd.name) + '(?=[ `])');
        expect(readme).toMatch(pattern);
      }
    });

    it('every command documented in the Core Commands section exists in the walker', () => {
      const coreCommandsSection = section(readme, '## Core Commands');
      const walkerNames = new Set(nonHidden.map(cmd => cmd.name));
      const documented = new Set<string>();
      const invocationPattern = /`dss ([a-z][a-z-]*)/g;
      let match: RegExpExecArray | null;
      while ((match = invocationPattern.exec(coreCommandsSection)) !== null) {
        documented.add(match[1]);
      }

      expect(documented.size).toBeGreaterThan(0);
      for (const name of documented) {
        expect(walkerNames.has(name)).toBe(true);
      }
    });
  });

  describe('walker vs AGENTS.md', () => {
    const agents = readFile(AGENTS_PATH);

    function findCommand(name: string): DescribedCommand | undefined {
      return nonHidden.find(cmd => cmd.name === name);
    }

    it('every `dss ...` recipe invocation uses a real command, action, and flags', () => {
      const invocationLines = agents.split('\n').filter(line => /^dss\s+\S/.test(line.trim()));
      expect(invocationLines.length).toBeGreaterThan(0);

      const allowedGlobalFlags = new Set(globalFlagTokens(described));

      for (const line of invocationLines) {
        const tokens = line.trim().split(/\s+/).slice(1); // drop the leading "dss"
        let effectiveOptions: { flags: string }[] = [];
        let flagStartIndex = 0;

        if (tokens[0] && !tokens[0].startsWith('-')) {
          const cmd = findCommand(tokens[0]);
          if (!cmd) {
            throw new Error(`AGENTS.md invokes unknown command "${tokens[0]}" in: "${line}"`);
          }
          flagStartIndex = 1;
          effectiveOptions = cmd.options;

          if (cmd.subcommands.length > 0 && tokens[1] && !tokens[1].startsWith('-')) {
            const sub = cmd.subcommands.find(candidate => candidate.name === tokens[1]);
            if (!sub) {
              throw new Error(`AGENTS.md uses unknown "${cmd.name}" action "${tokens[1]}" in: "${line}"`);
            }
            flagStartIndex = 2;
            effectiveOptions = sub.options;
          }
        }

        const allowedFlags = new Set([...allowedGlobalFlags, ...effectiveOptions.flatMap(option => flagTokens(option.flags))]);

        for (const token of tokens.slice(flagStartIndex)) {
          if (token.startsWith('-') && !allowedFlags.has(token)) {
            throw new Error(`AGENTS.md uses undeclared flag "${token}" in: "${line}"`);
          }
        }
      }
    });
  });

  describe('exit codes documented', () => {
    it("README's Exit codes section mentions every EXIT_CODES value", () => {
      const readme = readFile(README_PATH);
      const exitCodesSection = section(readme, '## Exit codes');
      for (const code of Object.values(EXIT_CODES)) {
        expect(exitCodesSection).toMatch(new RegExp('`' + code + '`'));
      }
    });
  });
});
