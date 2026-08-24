import { select, input, confirm, password, checkbox } from '@inquirer/prompts';
import {
  promptHost,
  guardedInput,
  guardedSelect,
  guardedPassword,
  guardedPromptHost,
  guardedConfirm,
  guardedCheckbox,
  isNonInteractive,
  setAssumeYes,
  assumeYes,
  UsageError,
} from '../../src/commands/prompts';

jest.mock('@inquirer/prompts', () => ({
  confirm: jest.fn(),
  password: jest.fn(),
  select: jest.fn(),
  input: jest.fn(),
  checkbox: jest.fn()
}));

const mockSelect = select as jest.MockedFunction<typeof select>;
const mockInput = input as jest.MockedFunction<typeof input>;
const mockConfirm = confirm as jest.MockedFunction<typeof confirm>;
const mockPassword = password as jest.MockedFunction<typeof password>;
const mockCheckbox = checkbox as jest.MockedFunction<typeof checkbox>;

/** Puts this test in non-interactive mode by making stdin look like a
 * closed/piped, non-TTY stream — tests/setup.ts's global beforeEach
 * defaults stdin to TTY=true (interactive) for every test (preserving all
 * the existing prompt-mocking tests unchanged), and resets it again before
 * the NEXT test runs, so no manual restore is needed here. */
function makeNonInteractive(): void {
  (process.stdin as any).isTTY = false;
}

describe('commands/prompts — promptHost', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('presents the known hosts plus "Other…", defaulting to github.com when no current host is given', async () => {
    mockSelect.mockResolvedValue('github.com');

    await promptHost();

    expect(mockSelect).toHaveBeenCalledWith({
      message: 'Git host:',
      choices: [
        { name: 'github.com', value: 'github.com' },
        { name: 'gitlab.com', value: 'gitlab.com' },
        { name: 'bitbucket.org', value: 'bitbucket.org' },
        { name: 'Other…', value: '__other__' }
      ],
      default: 'github.com'
    });
  });

  it('highlights the current host as the select default when editing', async () => {
    mockSelect.mockResolvedValue('gitlab.com');

    await promptHost('gitlab.com');

    expect(mockSelect).toHaveBeenCalledWith(expect.objectContaining({ default: 'gitlab.com' }));
  });

  it('returns the chosen known host directly without prompting for input', async () => {
    mockSelect.mockResolvedValue('bitbucket.org');

    const result = await promptHost();

    expect(result).toBe('bitbucket.org');
    expect(mockInput).not.toHaveBeenCalled();
  });

  it('falls through to a custom input prompt when "Other…" is chosen', async () => {
    mockSelect.mockResolvedValue('__other__');
    mockInput.mockResolvedValue('git.example.com');

    const result = await promptHost();

    expect(mockInput).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('Custom Git host')
    }));
    expect(result).toBe('git.example.com');
  });

  describe('custom host validation', () => {
    async function getValidator(): Promise<(value: string) => string | true> {
      mockSelect.mockResolvedValue('__other__');
      mockInput.mockResolvedValue('git.example.com');
      await promptHost();
      return mockInput.mock.calls[0][0].validate as (value: string) => string | true;
    }

    it('rejects an empty host', async () => {
      const validate = await getValidator();
      expect(validate('')).not.toBe(true);
      expect(validate('   ')).not.toBe(true);
    });

    it('rejects a host containing spaces', async () => {
      const validate = await getValidator();
      expect(validate('git example.com')).not.toBe(true);
    });

    it('rejects a host that includes a protocol', async () => {
      const validate = await getValidator();
      expect(validate('https://git.example.com')).not.toBe(true);
      expect(validate('http://git.example.com')).not.toBe(true);
    });

    it('accepts a bare hostname', async () => {
      const validate = await getValidator();
      expect(validate('git.example.com')).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------
// Phase 4 · Task 1 — non-interactive foundation: isNonInteractive(),
// assumeYes()/setAssumeYes(), UsageError, and the guarded* wrapper matrix
// (interactive / non-interactive / non-interactive-with-default /
// assumeYes / optional).
// ---------------------------------------------------------------------

describe('commands/prompts — isNonInteractive', () => {
  const originalEnv = process.env.DSS_NO_INPUT;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.DSS_NO_INPUT;
    else process.env.DSS_NO_INPUT = originalEnv;
  });

  it('is false when stdin is a TTY and DSS_NO_INPUT is unset (the interactive default)', () => {
    (process.stdin as any).isTTY = true;
    delete process.env.DSS_NO_INPUT;
    expect(isNonInteractive()).toBe(false);
  });

  it('is true when stdin is not a TTY (piped/closed), regardless of DSS_NO_INPUT', () => {
    makeNonInteractive();
    delete process.env.DSS_NO_INPUT;
    expect(isNonInteractive()).toBe(true);
  });

  it('is true when DSS_NO_INPUT=1, even on a TTY', () => {
    (process.stdin as any).isTTY = true;
    process.env.DSS_NO_INPUT = '1';
    expect(isNonInteractive()).toBe(true);
  });

  it('is a live check, not a value captured once — flipping stdin.isTTY mid-test changes the result', () => {
    (process.stdin as any).isTTY = true;
    expect(isNonInteractive()).toBe(false);
    (process.stdin as any).isTTY = false;
    expect(isNonInteractive()).toBe(true);
  });
});

describe('commands/prompts — assumeYes/setAssumeYes', () => {
  afterEach(() => {
    setAssumeYes(false); // don't leak into other test files
  });

  it('defaults to false', () => {
    expect(assumeYes()).toBe(false);
  });

  it('reflects the last setAssumeYes call', () => {
    setAssumeYes(true);
    expect(assumeYes()).toBe(true);
    setAssumeYes(false);
    expect(assumeYes()).toBe(false);
  });
});

describe('commands/prompts — UsageError', () => {
  it('carries exitCode 2 and is a real Error', () => {
    const error = new UsageError('boom');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('UsageError');
    expect(error.message).toBe('boom');
    expect(error.exitCode).toBe(2);
  });
});

describe('commands/prompts — guardedInput', () => {
  it('interactive: delegates to input() unchanged (flagName/nonInteractiveDefault stripped)', async () => {
    mockInput.mockResolvedValue('typed-value');

    const result = await guardedInput({
      message: 'Name:',
      flagName: '--name',
    });

    expect(result).toBe('typed-value');
    expect(mockInput).toHaveBeenCalledWith({ message: 'Name:' });
  });

  it('non-interactive, no default: throws UsageError naming flagName, never touches input()', async () => {
    makeNonInteractive();

    await expect(guardedInput({ message: 'Name:', flagName: '--name' }))
      .rejects.toThrow(UsageError);
    await expect(guardedInput({ message: 'Name:', flagName: '--name' }))
      .rejects.toThrow('Missing required value: pass --name (non-interactive mode)');
    expect(mockInput).not.toHaveBeenCalled();
  });

  it('non-interactive with nonInteractiveDefault: resolves the default, never touches input()', async () => {
    makeNonInteractive();

    const result = await guardedInput({
      message: 'New email (leave blank to skip):',
      flagName: '--email',
      nonInteractiveDefault: 'current@example.com',
    });

    expect(result).toBe('current@example.com');
    expect(mockInput).not.toHaveBeenCalled();
  });
});

describe('commands/prompts — guardedSelect', () => {
  const choices = [{ name: 'work', value: 'work' }];

  it('interactive: delegates to select() unchanged', async () => {
    mockSelect.mockResolvedValue('work');

    const result = await guardedSelect({
      message: 'Choose:',
      choices,
      flagName: 'the identityName argument',
    });

    expect(result).toBe('work');
    expect(mockSelect).toHaveBeenCalledWith({ message: 'Choose:', choices });
  });

  it('non-interactive, no default: throws UsageError naming the positional, never touches select()', async () => {
    makeNonInteractive();

    await expect(
      guardedSelect({ message: 'Choose:', choices, flagName: 'the identityName argument' })
    ).rejects.toThrow('Missing required value: pass the identityName argument (non-interactive mode)');
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('non-interactive with nonInteractiveDefault: resolves the default, never touches select()', async () => {
    makeNonInteractive();

    const result = await guardedSelect({
      message: 'Choose:',
      choices,
      flagName: '--host',
      nonInteractiveDefault: 'github.com',
    });

    expect(result).toBe('github.com');
    expect(mockSelect).not.toHaveBeenCalled();
  });
});

describe('commands/prompts — guardedPassword', () => {
  it('interactive: delegates to password() via safePassword (mask defaults true)', async () => {
    mockPassword.mockResolvedValue('hunter2');

    const result = await guardedPassword({
      message: 'Passphrase for the key (empty for none):',
      flagName: '--passphrase',
    });

    expect(result).toBe('hunter2');
    expect(mockPassword).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Passphrase for the key (empty for none):',
      mask: true,
    }));
  });

  it('non-interactive, no default: throws UsageError, never touches password()', async () => {
    makeNonInteractive();

    await expect(guardedPassword({ message: 'Passphrase:', flagName: '--passphrase' }))
      .rejects.toThrow('Missing required value: pass --passphrase (non-interactive mode)');
    expect(mockPassword).not.toHaveBeenCalled();
  });

  it('non-interactive with nonInteractiveDefault \'\' (empty passphrase default): resolves without touching password()', async () => {
    makeNonInteractive();

    const result = await guardedPassword({
      message: 'Passphrase:',
      flagName: '--passphrase',
      nonInteractiveDefault: '',
    });

    expect(result).toBe('');
    expect(mockPassword).not.toHaveBeenCalled();
  });
});

describe('commands/prompts — guardedPromptHost', () => {
  it('interactive: delegates to promptHost (select-backed)', async () => {
    mockSelect.mockResolvedValue('gitlab.com');

    const result = await guardedPromptHost({ flagName: '--host', currentHost: 'gitlab.com' });

    expect(result).toBe('gitlab.com');
    expect(mockSelect).toHaveBeenCalledWith(expect.objectContaining({ default: 'gitlab.com' }));
  });

  it('non-interactive, no default: throws UsageError, never touches select()', async () => {
    makeNonInteractive();

    await expect(guardedPromptHost({ flagName: '--host' }))
      .rejects.toThrow('Missing required value: pass --host (non-interactive mode)');
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('non-interactive with nonInteractiveDefault (edit keeps the current host): resolves without touching select()', async () => {
    makeNonInteractive();

    const result = await guardedPromptHost({
      flagName: '--host',
      currentHost: 'gitlab.com',
      nonInteractiveDefault: 'gitlab.com',
    });

    expect(result).toBe('gitlab.com');
    expect(mockSelect).not.toHaveBeenCalled();
  });
});

describe('commands/prompts — guardedConfirm', () => {
  afterEach(() => {
    setAssumeYes(false);
  });

  it('interactive, no -y: delegates to safeConfirm (calls confirm())', async () => {
    mockConfirm.mockResolvedValue(true);

    const result = await guardedConfirm({ message: 'Sure?', default: false });

    expect(result).toBe(true);
    expect(mockConfirm).toHaveBeenCalledWith({ message: 'Sure?', default: false });
  });

  it('non-interactive, required (optional unset), no -y: throws UsageError naming -y/--yes by default', async () => {
    makeNonInteractive();

    await expect(guardedConfirm({ message: 'Remove it?' }))
      .rejects.toThrow('Confirmation required: pass -y/--yes (non-interactive mode)');
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('non-interactive, required, no -y: UsageError names a custom `flag` when given', async () => {
    makeNonInteractive();

    await expect(guardedConfirm({ message: 'Remove it?', flag: '--force' }))
      .rejects.toThrow('Confirmation required: pass --force (non-interactive mode)');
  });

  it('non-interactive, optional: resolves false silently, never touches confirm()', async () => {
    makeNonInteractive();

    const result = await guardedConfirm({ message: 'Test SSH access?', default: false, optional: true });

    expect(result).toBe(false);
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('assumeYes(): resolves true and skips confirm() entirely, even interactively', async () => {
    setAssumeYes(true);

    const result = await guardedConfirm({ message: 'Sure?', default: false });

    expect(result).toBe(true);
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('assumeYes(): resolves true non-interactively too, for BOTH required and optional confirms', async () => {
    setAssumeYes(true);
    makeNonInteractive();

    await expect(guardedConfirm({ message: 'Required?' })).resolves.toBe(true);
    await expect(guardedConfirm({ message: 'Optional?', optional: true })).resolves.toBe(true);
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('a closed prompt (ExitPromptError) in interactive mode still resolves false (safeConfirm passthrough)', async () => {
    class ExitPromptError extends Error {}
    mockConfirm.mockRejectedValue(new ExitPromptError('closed'));

    await expect(guardedConfirm({ message: 'Sure?' })).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------
// Fix-report follow-up (Important #1): guardedCheckbox — added so
// `dss config export`'s multi-select has a proper guarded home instead of
// a hand-rolled bypass, following the same wrapper contract as every other
// guarded* prompt (interactive passthrough / non-interactive default or
// UsageError).
// ---------------------------------------------------------------------

describe('commands/prompts — guardedCheckbox', () => {
  const choices = [
    { name: 'work', value: 'work' },
    { name: 'personal', value: 'personal' },
  ];

  it('interactive: delegates to checkbox() unchanged (flagName/nonInteractiveDefault stripped)', async () => {
    mockCheckbox.mockResolvedValue(['work']);

    const result = await guardedCheckbox({
      message: 'Select identities to export:',
      choices,
      flagName: '--all',
    });

    expect(result).toEqual(['work']);
    expect(mockCheckbox).toHaveBeenCalledWith({ message: 'Select identities to export:', choices });
  });

  it('non-interactive with nonInteractiveDefault (export-all): resolves the default, never touches checkbox()', async () => {
    makeNonInteractive();

    const result = await guardedCheckbox({
      message: 'Select identities to export:',
      choices,
      flagName: '--all',
      nonInteractiveDefault: ['work', 'personal'],
    });

    expect(result).toEqual(['work', 'personal']);
    expect(mockCheckbox).not.toHaveBeenCalled();
  });

  it('non-interactive, no default: throws UsageError naming flagName, never touches checkbox()', async () => {
    makeNonInteractive();

    await expect(guardedCheckbox({ message: 'Select:', choices, flagName: '--all' }))
      .rejects.toThrow('Missing required value: pass --all (non-interactive mode)');
    expect(mockCheckbox).not.toHaveBeenCalled();
  });
});
