import { select, input } from '@inquirer/prompts';
import { promptHost } from '../../src/commands/prompts';

jest.mock('@inquirer/prompts', () => ({
  confirm: jest.fn(),
  password: jest.fn(),
  select: jest.fn(),
  input: jest.fn()
}));

const mockSelect = select as jest.MockedFunction<typeof select>;
const mockInput = input as jest.MockedFunction<typeof input>;

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
