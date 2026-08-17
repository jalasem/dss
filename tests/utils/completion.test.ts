import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { confirm } from '@inquirer/prompts';
import { generateCompletionScript } from '../../src/utils/completion';

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
    JSON.stringify({ spaces: [{ name: 'aweds-personal' }, { name: 'client-work' }] })
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
      JSON.stringify({
        spaces: [
          { name: 'aweds-personal' },
          { name: 'client-work' }
        ]
      })
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
