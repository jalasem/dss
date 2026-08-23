import { ISpace } from '../../src/core/types';

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
