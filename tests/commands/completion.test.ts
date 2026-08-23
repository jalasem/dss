import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { confirm } from '@inquirer/prompts';
import { generateCompletionScript } from '../../src/commands/completion';

jest.mock('@inquirer/prompts', () => ({
  confirm: jest.fn(),
  select: jest.fn()
}));

function hasZsh(): boolean {
  const environment = createZshEnvironment('dss-zsh-availability-', false);

  try {
    execFileSync('zsh', ['-fc', 'exit 0'], {
      stdio: 'pipe',
      env: {
        ...process.env,
        HOME: environment.homeDirectory,
        ZDOTDIR: environment.zdotdir
      }
    });
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(environment.temporaryDirectory, { recursive: true, force: true });
  }
}

function hasFish(): boolean {
  try {
    execFileSync('fish', ['--no-config', '-c', 'exit 0'], {
      stdio: 'pipe',
      env: { PATH: process.env.PATH }
    });
    return true;
  } catch {
    return false;
  }
}

// Matches the store's real on-disk shape and formatting: fs-extra's
// writeJson({ spaces: 2 }) is JSON.stringify(obj, null, 2), which always
// puts a space after each key's colon (`"name": "value"`) — unlike the
// legacy v1 config these completion scripts were originally written
// against, which was written compact (`"name":"value"`, no space).
function v2ConfigJson(spaceNames: string[]): string {
  const store = {
    version: 2,
    identities: spaceNames.map(name => ({
      name,
      email: `${name}@example.com`,
      userName: name,
      host: 'github.com'
    })),
    bindings: []
  };
  return JSON.stringify(store, null, 2);
}

function createCompletionHome(prefix: string): {
  temporaryDirectory: string;
  homeDirectory: string;
  scriptDirectory: string;
} {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const homeDirectory = path.join(temporaryDirectory, 'home');
  const scriptDirectory = path.join(temporaryDirectory, 'scripts');
  fs.mkdirSync(path.join(homeDirectory, '.dss', 'spaces'), { recursive: true });
  fs.mkdirSync(scriptDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(homeDirectory, '.dss', 'spaces', 'config.json'),
    v2ConfigJson(['aweds-personal', 'client-work'])
  );
  return { temporaryDirectory, homeDirectory, scriptDirectory };
}

function createZshEnvironment(prefix: string, poisonStartupFiles: boolean): {
  temporaryDirectory: string;
  homeDirectory: string;
  zdotdir: string;
} {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const homeDirectory = path.join(temporaryDirectory, 'home');
  const zdotdir = path.join(temporaryDirectory, 'zdotdir');

  fs.mkdirSync(homeDirectory, { recursive: true });
  fs.mkdirSync(zdotdir, { recursive: true });

  if (poisonStartupFiles) {
    const poisonScript = 'print -r -- "startup-files-loaded"\nexit 91\n';
    fs.writeFileSync(path.join(homeDirectory, '.zshenv'), poisonScript);
    fs.writeFileSync(path.join(zdotdir, '.zshenv'), poisonScript);
    fs.writeFileSync(path.join(zdotdir, '.zshrc'), poisonScript);
  }

  return {
    temporaryDirectory,
    homeDirectory,
    zdotdir
  };
}

describe('completion script generation', () => {
  const mockedConfirm = confirm as jest.MockedFunction<typeof confirm>;
  const zshIt = hasZsh() ? it : it.skip;
  const fishIt = hasFish() ? it : it.skip;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedConfirm.mockResolvedValue(false);
  });

  function extractGeneratedScript(output: string): string {
    const marker = '--- Completion Script ---';
    const endMarker = '--- End of Script ---';
    const startIndex = output.indexOf(marker);
    const endIndex = output.indexOf(endMarker);

    if (startIndex === -1 || endIndex === -1) {
      throw new Error('Completion script markers were not found in the output.');
    }

    return output.slice(startIndex + marker.length, endIndex).trim();
  }

  async function captureCompletionOutput(shell: string): Promise<string> {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

    try {
      await generateCompletionScript(shell);
      return consoleSpy.mock.calls.flat().join('\n');
    } finally {
      consoleSpy.mockRestore();
    }
  }

  it.each([
    ['bash'],
    ['zsh'],
    ['fish']
  ])('includes repository binding commands in %s output', async (shell) => {
    const output = await captureCompletionOutput(shell);

    expect(output).toContain('bind');
    expect(output).toContain('unbind');
    expect(output).toContain('status');
  });

  it.each([
    ['bash'],
    ['fish']
  ])('includes bind options in %s output', async (shell) => {
    const output = await captureCompletionOutput(shell);

    expect(output).toContain('--path');
    expect(output).toContain('--recursive');
    expect(output).toContain('--dry-run');
  });

  it('includes bind, unbind, and status aliases in bash output', async () => {
    const script = extractGeneratedScript(await captureCompletionOutput('bash'));

    expect(script).toMatch(/bind\)[\s\S]*opts="[^"]*-p[^"]*--path[^"]*-r[^"]*--recursive[^"]*--dry-run"/);
    expect(script).toMatch(/unbind\)[\s\S]*opts="[^"]*-p[^"]*--path[^"]*--dry-run"/);
    expect(script).toMatch(/status\)[\s\S]*opts="[^"]*-p[^"]*--path"/);
  });

  it('includes bind, unbind, and status aliases in zsh output', async () => {
    const script = extractGeneratedScript(await captureCompletionOutput('zsh'));

    expect(script).toContain("'-p[Bind an explicit Git repository]'");
    expect(script).toContain("'--path[Bind an explicit Git repository]'");
    expect(script).toContain("'-r[Bind repositories beneath a parent directory]'");
    expect(script).toContain("'--recursive[Bind repositories beneath a parent directory]'");
    expect(script).toContain("'-p[Select an explicit Git repository]'");
    expect(script).toContain("'--path[Select an explicit Git repository]'");
  });

  it('includes bind, unbind, and status aliases in fish output', async () => {
    const script = extractGeneratedScript(await captureCompletionOutput('fish'));

    expect(script).toContain("-s p -l path -r");
    expect(script).toContain("-s r -l recursive");
    expect(script).toContain("-s p -l path -r -d 'Select an explicit Git repository");
  });

  it('sources bash completions and completes configured spaces and bind options', async () => {
    const script = extractGeneratedScript(await captureCompletionOutput('bash'));
    const environment = createCompletionHome('dss-bash-completion-');
    const scriptPath = path.join(environment.scriptDirectory, 'dss-completion.bash');
    fs.writeFileSync(scriptPath, script);
    const childEnvironment = {
      HOME: environment.homeDirectory,
      PATH: process.env.PATH,
      BASH_ENV: '/dev/null'
    };

    try {
      expect(() => execFileSync('bash', ['--noprofile', '--norc', '-n', scriptPath], {
        stdio: 'pipe',
        env: childEnvironment
      })).not.toThrow();

      const runtimeOutput = execFileSync('bash', [
        '--noprofile',
        '--norc',
        '-c',
        [
          `source ${JSON.stringify(scriptPath)}`,
          'COMP_WORDS=(dss bind aw)',
          'COMP_CWORD=2',
          '_dss_completion',
          'printf "space:%s\\n" "${COMPREPLY[@]}"',
          'COMP_WORDS=(dss bind --r)',
          'COMP_CWORD=2',
          '_dss_completion',
          'printf "option:%s\\n" "${COMPREPLY[@]}"'
        ].join('; ')
      ], {
        encoding: 'utf8',
        env: childEnvironment,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      expect(runtimeOutput).toContain('space:aweds-personal');
      expect(runtimeOutput).toContain('option:--recursive');
    } finally {
      fs.rmSync(environment.temporaryDirectory, { recursive: true, force: true });
    }
  });

  // Pulls the literal name-extraction statement out of a generated script
  // (not a hand-copied guess at it) and runs it verbatim under bash with
  // HOME redirected at a temp config directory, so `~` resolves there.
  // Proves the actual shipped grep/cut pipeline — not an assumption about
  // it — tolerates the store's pretty-printed `"name": "value"` (space
  // after the colon), not only the legacy compact `"name":"value"`.
  //
  // The bash variant's statement embeds a *literal* newline byte (not the
  // two characters `\`+`n`) inside `tr '<newline>' ' '` — the template
  // literal in completion.ts writes an actual `\n` escape, which the JS
  // engine turns into a real newline character in the generated script, and
  // `tr` translates it to a space just the same as it would `tr '\n' ' '`
  // with an escape sequence. A naive line-split trips over that embedded
  // byte, so bash gets its own regex spanning it; fish/zsh have no `tr`
  // call and split cleanly on real line boundaries.
  function extractSpaceLine(script: string, shell: 'bash' | 'fish' | 'zsh'): string {
    if (shell === 'bash') {
      const match = script.match(/spaces=\$\(cat ~\/\.dss\/spaces\/config\.json[\s\S]*?\| tr '\n' ' '\)/);
      if (!match) throw new Error('Could not find the bash space-extraction statement in the generated script.');
      return match[0];
    }
    const line = script.split('\n').find(candidate => candidate.includes('grep -o'));
    if (!line) throw new Error('Could not find the grep -o space-extraction line in the generated script.');
    return line.trim();
  }

  function runEmbeddedLine(line: string, homeDirectory: string, suffix: string): string {
    return execFileSync('bash', [
      '--noprofile',
      '--norc',
      '-c',
      `${line}${suffix}`
    ], {
      encoding: 'utf8',
      env: { HOME: homeDirectory, PATH: process.env.PATH }
    }).trim();
  }

  it('extracts space names from a pretty-printed (v2) config.json using the exact line embedded in the bash script', async () => {
    const script = extractGeneratedScript(await captureCompletionOutput('bash'));
    const line = extractSpaceLine(script, 'bash');
    expect(line).toContain('grep -o');

    const environment = createCompletionHome('dss-bash-pipeline-');

    try {
      const output = runEmbeddedLine(line, environment.homeDirectory, '; echo "$spaces"');
      const names = output.split(/\s+/).filter(Boolean).sort();
      expect(names).toEqual(['aweds-personal', 'client-work'].sort());
    } finally {
      fs.rmSync(environment.temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('extracts space names from a pretty-printed (v2) config.json using the exact line embedded in the fish script', async () => {
    const script = extractGeneratedScript(await captureCompletionOutput('fish'));
    const line = extractSpaceLine(script, 'fish');
    expect(line).toContain('grep -o');

    const environment = createCompletionHome('dss-fish-pipeline-');

    try {
      // The fish script's line is a bare pipeline (no assignment) that
      // prints directly — also valid syntax under bash.
      const output = runEmbeddedLine(line, environment.homeDirectory, '');
      const names = output.split(/\s+/).filter(Boolean).sort();
      expect(names).toEqual(['aweds-personal', 'client-work'].sort());
    } finally {
      fs.rmSync(environment.temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('extracts space names from a pretty-printed (v2) config.json using the exact line embedded in the zsh script', async () => {
    const script = extractGeneratedScript(await captureCompletionOutput('zsh'));
    const line = extractSpaceLine(script, 'zsh');
    expect(line).toContain('grep -o');

    const environment = createCompletionHome('dss-zsh-pipeline-');

    try {
      // bash also supports `arr=($(cmd))` array-literal assignment, so the
      // zsh script's line runs unmodified here too.
      const output = runEmbeddedLine(line, environment.homeDirectory, '; printf "%s\\n" "${spaces[@]}"');
      const names = output.split(/\s+/).filter(Boolean).sort();
      expect(names).toEqual(['aweds-personal', 'client-work'].sort());
    } finally {
      fs.rmSync(environment.temporaryDirectory, { recursive: true, force: true });
    }
  });

  fishIt('parses and sources fish completions with configured spaces', async () => {
    const script = extractGeneratedScript(await captureCompletionOutput('fish'));
    const environment = createCompletionHome('dss-fish-completion-');
    const scriptPath = path.join(environment.scriptDirectory, 'dss-completion.fish');
    fs.writeFileSync(scriptPath, script);
    const childEnvironment = {
      HOME: environment.homeDirectory,
      PATH: process.env.PATH,
      XDG_CONFIG_HOME: path.join(environment.homeDirectory, '.config')
    };

    try {
      expect(() => execFileSync('fish', ['--no-config', '-n', scriptPath], {
        stdio: 'pipe',
        env: childEnvironment
      })).not.toThrow();

      const runtimeOutput = execFileSync('fish', [
        '--no-config',
        '-c',
        `source ${JSON.stringify(scriptPath)}; __dss_get_spaces; complete -C 'dss bind --r'`
      ], {
        encoding: 'utf8',
        env: childEnvironment,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      expect(runtimeOutput).toContain('aweds-personal');
      expect(runtimeOutput).toContain('--recursive');
    } finally {
      fs.rmSync(environment.temporaryDirectory, { recursive: true, force: true });
    }
  });

  zshIt('generates parseable zsh completions that extract configured space names', async () => {
    const output = await captureCompletionOutput('zsh');
    const script = extractGeneratedScript(output);
    const environment = createZshEnvironment('dss-zsh-completion-', true);
    const temporaryDirectory = environment.temporaryDirectory;
    const scriptPath = path.join(temporaryDirectory, '_dss');

    fs.writeFileSync(scriptPath, script);

    try {
      expect(script).toContain('~/.dss/spaces/config.json');
      expect(script).not.toContain('dummy');

      expect(() => {
        execFileSync('zsh', ['-fn', scriptPath], {
          stdio: 'pipe',
          env: {
            ...process.env,
            HOME: environment.homeDirectory,
            ZDOTDIR: environment.zdotdir
          }
        });
      }).not.toThrow();
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  zshIt('sources zsh completions and offers configured spaces for bind', async () => {
    const output = await captureCompletionOutput('zsh');
    const script = extractGeneratedScript(output);
    const environment = createZshEnvironment('dss-zsh-runtime-', true);
    const temporaryDirectory = environment.temporaryDirectory;
    const scriptPath = path.join(temporaryDirectory, '_dss');
    const spacesDirectory = path.join(environment.homeDirectory, '.dss', 'spaces');
    const harnessPath = path.join(temporaryDirectory, 'harness.zsh');

    fs.mkdirSync(spacesDirectory, { recursive: true });
    fs.writeFileSync(scriptPath, script);
    fs.writeFileSync(
      path.join(spacesDirectory, 'config.json'),
      v2ConfigJson(['aweds-personal', 'client-work'])
    );
    fs.writeFileSync(
      harnessPath,
      [
        '#!/bin/zsh',
        'compdef() { return 0; }',
        '_arguments() {',
        '  state=args',
        '  return 1',
        '}',
        '_describe() {',
        '  local label="$1"',
        '  local array_name="$2"',
        '  print -r -- "$label:${(j:,:)${(P)array_name}}"',
        '  return 0',
        '}',
        '_values() {',
        '  print -r -- "unexpected-values:$*"',
        '  return 0',
        '}',
        `source ${JSON.stringify(scriptPath)}`,
        'words=(dss bind aw)',
        'CURRENT=3',
        '_dss',
        ''
      ].join('\n')
    );

    try {
      const runtimeOutput = execFileSync('zsh', ['-fc', `source ${JSON.stringify(harnessPath)}`], {
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: environment.homeDirectory,
          ZDOTDIR: environment.zdotdir
        },
        stdio: ['ignore', 'pipe', 'pipe']
      }).trim();

      expect(runtimeOutput).toContain('spaces:aweds-personal,client-work');
      expect(runtimeOutput).not.toContain('unexpected-values');
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
