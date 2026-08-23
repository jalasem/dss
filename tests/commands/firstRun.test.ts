import { confirm } from '@inquirer/prompts';

jest.mock('@inquirer/prompts', () => ({
  confirm: jest.fn(),
  select: jest.fn(),
  input: jest.fn(),
  password: jest.fn(),
  checkbox: jest.fn()
}));
jest.mock('../../src/infra/store', () => ({
  loadConfig: jest.fn()
}));
jest.mock('../../src/commands/spaces', () => ({
  addSpace: jest.fn()
}));

const { firstRunFlow } = require('../../src/commands/firstRun');
const { loadConfig } = require('../../src/infra/store');
const { addSpace } = require('../../src/commands/spaces');

const mockConfirm = confirm as jest.MockedFunction<typeof confirm>;
const mockLoadConfig = loadConfig as jest.MockedFunction<() => Promise<{ config: { spaces: unknown[] } }>>;
const mockAddSpace = addSpace as jest.MockedFunction<() => Promise<void>>;

// Mirrors @inquirer/core exactly (see tests/commands/spaces.test.ts): the
// class does NOT override `name`, so isPromptExitError can't rely on
// error.name === 'ExitPromptError'.
class ExitPromptError extends Error {}

describe('commands/firstRun firstRunFlow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation();
  });

  it('is a no-op (returns false) and does not load config again when a non-empty config is passed in', async () => {
    const result = await firstRunFlow({ spaces: [{ name: 'existing' }] } as any);

    expect(result).toBe(false);
    expect(mockLoadConfig).not.toHaveBeenCalled();
    expect(mockAddSpace).not.toHaveBeenCalled();
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('loads config itself when the caller does not pass one, and is a no-op when it is non-empty', async () => {
    mockLoadConfig.mockResolvedValue({ config: { spaces: [{ name: 'existing' }] } });

    const result = await firstRunFlow();

    expect(result).toBe(false);
    expect(mockLoadConfig).toHaveBeenCalledTimes(1);
    expect(mockAddSpace).not.toHaveBeenCalled();
  });

  it('prints the welcome banner and creates the first identity when the user accepts', async () => {
    mockConfirm.mockResolvedValue(true);

    const result = await firstRunFlow({ spaces: [] } as any);

    expect(result).toBe(true);
    expect(mockAddSpace).toHaveBeenCalledTimes(1);
    const calls = (console.log as jest.Mock).mock.calls.flat();
    expect(calls.some(call => call && call.includes && call.includes('Dev Spaces Switcher'))).toBe(true);
  });

  it('prints a hint (without calling addSpace) when the user declines', async () => {
    mockConfirm.mockResolvedValue(false);

    const result = await firstRunFlow({ spaces: [] } as any);

    expect(result).toBe(true);
    expect(mockAddSpace).not.toHaveBeenCalled();
    const calls = (console.log as jest.Mock).mock.calls.flat();
    expect(calls.some(call => call && call.includes && call.includes('dss new'))).toBe(true);
  });

  it('treats a cancelled confirm prompt as declined (safeConfirm), not a crash', async () => {
    mockConfirm.mockRejectedValue(new ExitPromptError('User force closed the prompt with 0 null'));

    const result = await firstRunFlow({ spaces: [] } as any);

    expect(result).toBe(true);
    expect(mockAddSpace).not.toHaveBeenCalled();
  });
});
