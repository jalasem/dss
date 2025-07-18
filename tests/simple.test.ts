import { UIHelper } from '../src/utils/ui';
import { FuzzySpaceSearch } from '../src/utils/fuzzySearch';
import { ISpace } from '../src/utils/types';

describe('Simple Unit Tests', () => {
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

  describe('FuzzySpaceSearch', () => {
    const mockSpaces: ISpace[] = [
      {
        name: 'work-space',
        email: 'work@example.com',
        userName: 'Work User',
        sshKeyPath: '/path/to/work/key'
      },
      {
        name: 'personal-space',
        email: 'personal@example.com',
        userName: 'Personal User',
        sshKeyPath: '/path/to/personal/key'
      },
      {
        name: 'client-project',
        email: 'client@example.com',
        userName: 'Client User',
        sshKeyPath: '/path/to/client/key'
      }
    ];

    it('should search spaces by name', () => {
      const searcher = new FuzzySpaceSearch(mockSpaces);
      const results = searcher.search('work');
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('work-space');
    });

    it('should search spaces by email', () => {
      const searcher = new FuzzySpaceSearch(mockSpaces);
      const results = searcher.search('personal@example.com');
      expect(results).toHaveLength(1);
      expect(results[0].email).toBe('personal@example.com');
    });

    it('should search spaces by user name', () => {
      const searcher = new FuzzySpaceSearch(mockSpaces);
      const results = searcher.search('Client User');
      expect(results).toHaveLength(1);
      expect(results[0].userName).toBe('Client User');
    });

    it('should return empty array for no matches', () => {
      const searcher = new FuzzySpaceSearch(mockSpaces);
      const results = searcher.search('nonexistent');
      expect(results).toHaveLength(0);
    });

    it('should return empty array for empty query', () => {
      const searcher = new FuzzySpaceSearch(mockSpaces);
      const results = searcher.search('');
      expect(results).toHaveLength(0);
    });

    it('should highlight text matches', () => {
      const highlighted = FuzzySpaceSearch.highlightMatch('work-space', 'work');
      expect(highlighted).toContain('work');
    });

    it('should return original text for empty query', () => {
      const highlighted = FuzzySpaceSearch.highlightMatch('work-space', '');
      expect(highlighted).toBe('work-space');
    });

    it('should generate search choices', () => {
      const choices = FuzzySpaceSearch.getSearchChoices(mockSpaces, 'work');
      expect(choices).toHaveLength(1);
      expect(choices[0].name).toBe('work-space');
      expect(choices[0].value).toBe('work-space');
      expect(choices[0].description).toContain('work@example.com');
    });

    it('should mark active space in choices', () => {
      const choices = FuzzySpaceSearch.getSearchChoices(mockSpaces, '', 'work-space');
      const activeChoice = choices.find(c => c.value === 'work-space');
      expect(activeChoice?.name).toContain('🔥');
    });
  });

  describe('Type Definitions', () => {
    it('should define ISpace interface correctly', () => {
      const space: ISpace = {
        name: 'test-space',
        email: 'test@example.com',
        userName: 'Test User',
        sshKeyPath: '/path/to/key'
      };

      expect(space.name).toBe('test-space');
      expect(space.email).toBe('test@example.com');
      expect(space.userName).toBe('Test User');
      expect(space.sshKeyPath).toBe('/path/to/key');
    });
  });
});