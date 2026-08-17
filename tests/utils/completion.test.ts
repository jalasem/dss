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
  try {
    execFileSync('zsh', ['-lc', 'exit 0'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

describe('completion script generation', () => {
  const mockedConfirm = confirm as jest.MockedFunction<typeof confirm>;
  const zshIt = hasZsh() ? it : it.skip;

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

  zshIt('generates parseable zsh completions that extract configured space names', async () => {
    const output = await captureCompletionOutput('zsh');
    const script = extractGeneratedScript(output);
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dss-zsh-completion-'));
    const scriptPath = path.join(temporaryDirectory, '_dss');

    fs.writeFileSync(scriptPath, script);

    try {
      expect(script).toContain('~/.dss/spaces/config.json');
      expect(script).not.toContain('dummy');

      expect(() => {
        execFileSync('zsh', ['-n', scriptPath], { stdio: 'pipe' });
      }).not.toThrow();
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  zshIt('sources zsh completions and offers configured spaces for bind', async () => {
    const output = await captureCompletionOutput('zsh');
    const script = extractGeneratedScript(output);
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dss-zsh-runtime-'));
    const scriptPath = path.join(temporaryDirectory, '_dss');
    const spacesDirectory = path.join(temporaryDirectory, '.dss', 'spaces');
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
      const runtimeOutput = execFileSync('zsh', [harnessPath], {
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: temporaryDirectory
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
