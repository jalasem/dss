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

describe('completion script generation', () => {
  const mockedConfirm = confirm as jest.MockedFunction<typeof confirm>;

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

  it('generates parseable zsh completions that extract configured space names', async () => {
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
});
