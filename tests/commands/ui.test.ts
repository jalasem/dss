import { UIHelper } from '../../src/commands/ui';

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
});
