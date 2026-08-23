import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { copyToClipboard } from '../../src/infra/clipboard';

jest.mock('child_process');

const mockSpawn = spawn as unknown as jest.MockedFunction<typeof spawn>;

function createMockChildProcess() {
  const child: any = new EventEmitter();
  const stdin: any = new EventEmitter();
  stdin.write = jest.fn();
  stdin.end = jest.fn();
  child.stdin = stdin;
  return child;
}

describe('infra/clipboard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('copyToClipboard', () => {
    const mockPublicKey = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ test@example.com';

    beforeEach(() => {
      Object.defineProperty(process, 'platform', {
        value: 'darwin',
        writable: true
      });
    });

    it('should copy to clipboard on macOS', async () => {
      const child = createMockChildProcess();
      mockSpawn.mockImplementation((command: any, args: any) => {
        expect(command).toBe('pbcopy');
        expect(args).toEqual([]);
        return child;
      });

      const promise = copyToClipboard(mockPublicKey);
      child.emit('close', 0);
      await promise;

      expect(mockSpawn).toHaveBeenCalledWith('pbcopy', []);
      expect(child.stdin.write).toHaveBeenCalledWith(mockPublicKey);
      expect(child.stdin.end).toHaveBeenCalled();
    });

    it('should copy to clipboard on Windows', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });

      const child = createMockChildProcess();
      mockSpawn.mockImplementation((command: any, args: any) => {
        expect(command).toBe('clip');
        expect(args).toEqual([]);
        return child;
      });

      const promise = copyToClipboard(mockPublicKey);
      child.emit('close', 0);
      await promise;

      expect(mockSpawn).toHaveBeenCalledWith('clip', []);
    });

    it('should copy to clipboard on Linux', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });

      const child = createMockChildProcess();
      mockSpawn.mockImplementation((command: any, args: any) => {
        expect(command).toBe('xclip');
        expect(args).toEqual(['-selection', 'clipboard']);
        return child;
      });

      const promise = copyToClipboard(mockPublicKey);
      child.emit('close', 0);
      await promise;

      expect(mockSpawn).toHaveBeenCalledWith('xclip', ['-selection', 'clipboard']);
    });

    it('should reject on unsupported platform', async () => {
      Object.defineProperty(process, 'platform', { value: 'unsupported' });

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      await expect(copyToClipboard(mockPublicKey)).rejects.toThrow(
        'Unsupported platform for clipboard operations.'
      );

      consoleSpy.mockRestore();
    });

    it('should handle clipboard errors', async () => {
      const child = createMockChildProcess();
      mockSpawn.mockImplementation(() => child);

      const promise = copyToClipboard(mockPublicKey);
      const mockError = new Error('Clipboard not available');
      child.emit('error', mockError);

      await expect(promise).rejects.toThrow(mockError);
    });

    it('should reject when the clipboard process exits with a non-zero code', async () => {
      const child = createMockChildProcess();
      mockSpawn.mockImplementation(() => child);

      const promise = copyToClipboard(mockPublicKey);
      child.emit('close', 1);

      await expect(promise).rejects.toThrow('pbcopy exited with code 1');
    });

    it('rejects (instead of crashing) when the stdin pipe emits an error (regression)', async () => {
      const child = createMockChildProcess();
      mockSpawn.mockImplementation(() => child);

      const promise = copyToClipboard(mockPublicKey);
      const stdinError = new Error('EPIPE: write after end');
      child.stdin.emit('error', stdinError);

      await expect(promise).rejects.toThrow(stdinError);
    });

    it('does not double-settle when both a stdin error and a close event fire', async () => {
      const child = createMockChildProcess();
      mockSpawn.mockImplementation(() => child);

      const promise = copyToClipboard(mockPublicKey);
      const stdinError = new Error('EPIPE: write after end');
      child.stdin.emit('error', stdinError);
      child.emit('close', 0);

      await expect(promise).rejects.toThrow(stdinError);
    });
  });
});
