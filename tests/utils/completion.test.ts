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

  it.each([
    ['bash'],
    ['zsh'],
    ['fish']
  ])('includes repository binding commands in %s output', async (shell) => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

    await generateCompletionScript(shell);

    const output = consoleSpy.mock.calls.flat().join('\n');

    expect(output).toContain('bind');
    expect(output).toContain('unbind');
    expect(output).toContain('status');

    consoleSpy.mockRestore();
  });

  it.each([
    ['bash'],
    ['fish']
  ])('includes bind options in %s output', async (shell) => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

    await generateCompletionScript(shell);

    const output = consoleSpy.mock.calls.flat().join('\n');

    expect(output).toContain('--path');
    expect(output).toContain('--recursive');
    expect(output).toContain('--dry-run');

    consoleSpy.mockRestore();
  });
});
