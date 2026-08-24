import os from 'os';
import { performance } from 'perf_hooks';
import { addSpace, listSpaces, switchSpace } from '../src/commands/spaces';
import { loadStore, saveStore, fromSpace, IStoreV2 } from '../src/infra/store';
import { ISpace } from '../src/core/types';

// Mock external dependencies for performance tests
jest.mock('fs-extra');
jest.mock('child_process');
jest.mock('@inquirer/prompts');
jest.mock('../src/infra/keys');
jest.mock('../src/infra/ssh');
jest.mock('../src/infra/clipboard');
jest.mock('../src/infra/store', () => {
  const actual = jest.requireActual('../src/infra/store');
  const loadStore = jest.fn();
  const saveStore = jest.fn();
  // loadConfig/persistConfig are defined in the real module in terms of a
  // same-file reference to loadStore/saveStore, which a jest.mock property
  // override can't intercept. Rebuild them here on top of the mocks so
  // listSpaces/switchSpace (which go through loadConfig/persistConfig) still
  // observe the mocked loadStore/saveStore.
  return {
    ...actual,
    loadStore,
    saveStore,
    loadConfig: async () => {
      const store = await loadStore();
      const originalBySpace = new Map();
      const spaces = store.identities.map((identity: any) => {
        const space = actual.toSpace(identity);
        originalBySpace.set(space, identity);
        return space;
      });
      return { store, config: { spaces, activeSpace: store.active }, originalBySpace };
    },
    persistConfig: async (store: any, config: any, originalBySpace: Map<any, any>) => {
      store.identities = config.spaces.map((space: any) => actual.mergeIdentity(space, originalBySpace.get(space)));
      store.active = config.activeSpace;
      await saveStore(store);
    }
  };
});

function storeOf(spaces: ISpace[], active?: string): IStoreV2 {
  return { version: 2, identities: spaces.map(fromSpace), active, bindings: [], rules: [] };
}

describe('Performance Tests', () => {
  const mockHomeDir = '/mock/home';
  const mockLoadStore = loadStore as jest.MockedFunction<typeof loadStore>;
  const mockSaveStore = saveStore as jest.MockedFunction<typeof saveStore>;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(os, 'homedir').mockReturnValue(mockHomeDir);
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
    mockSaveStore.mockResolvedValue(undefined);
  });

  describe('Space Operations Performance', () => {
    it('should list spaces quickly even with many spaces', async () => {
      const mockSpaces = Array.from({ length: 100 }, (_, i) => ({
        name: `space-${i}`,
        email: `user${i}@example.com`,
        userName: `User ${i}`,
        sshKeyPath: `/mock/path/space-${i}/id_rsa`
      }));

      mockLoadStore.mockResolvedValue(storeOf(mockSpaces));

      const startTime = performance.now();
      await listSpaces();
      const endTime = performance.now();

      const executionTime = endTime - startTime;
      expect(executionTime).toBeLessThan(100); // Should complete within 100ms
    });

    it('should handle space switching efficiently', async () => {
      const mockSpace = {
        name: 'test-space',
        email: 'test@example.com',
        userName: 'Test User',
        sshKeyPath: '/mock/path/test-space/id_rsa'
      };

      mockLoadStore.mockResolvedValue(storeOf([mockSpace]));

      const { execFile } = require('child_process');
      execFile.mockImplementation((_file: string, _args: string[], callback: any) => {
        callback(null, { stdout: '', stderr: '' });
      });

      const { confirm } = require('@inquirer/prompts');
      confirm.mockResolvedValue(false);

      const startTime = performance.now();
      await switchSpace('test-space');
      const endTime = performance.now();

      const executionTime = endTime - startTime;
      expect(executionTime).toBeLessThan(200); // Should complete within 200ms
    });

    it('should handle configuration file operations efficiently', async () => {
      mockLoadStore.mockResolvedValue(storeOf([]));

      const operations = [];
      const startTime = performance.now();

      // Simulate multiple rapid configuration operations
      for (let i = 0; i < 10; i++) {
        operations.push(loadStore());
        operations.push(saveStore(storeOf([])));
      }

      await Promise.all(operations);
      const endTime = performance.now();

      const executionTime = endTime - startTime;
      expect(executionTime).toBeLessThan(50); // Should complete within 50ms
    });
  });

  describe('Memory Usage Tests', () => {
    it('should not leak memory during repeated operations', async () => {
      mockLoadStore.mockResolvedValue(storeOf([]));

      const initialMemory = process.memoryUsage().heapUsed;

      // Perform many operations
      for (let i = 0; i < 50; i++) {
        await listSpaces();
      }

      // Force garbage collection if available
      if (global.gc) {
        global.gc();
      }

      const finalMemory = process.memoryUsage().heapUsed;
      const memoryIncrease = finalMemory - initialMemory;

      // Memory increase should be minimal (less than 10MB)
      expect(memoryIncrease).toBeLessThan(10 * 1024 * 1024);
    });
  });

  describe('Stress Tests', () => {
    it('should handle concurrent operations gracefully', async () => {
      mockLoadStore.mockResolvedValue(storeOf([]));

      const concurrentOperations = Array.from({ length: 20 }, () => listSpaces());

      const startTime = performance.now();
      await Promise.all(concurrentOperations);
      const endTime = performance.now();

      const executionTime = endTime - startTime;
      expect(executionTime).toBeLessThan(500); // Should complete within 500ms
    });

    it('should handle large configuration files efficiently', async () => {
      const largeSpacesArray = Array.from({ length: 1000 }, (_, i) => ({
        name: `space-${i}`,
        email: `user${i}@example.com`,
        userName: `User ${i}`,
        sshKeyPath: `/mock/path/space-${i}/id_rsa`
      }));

      mockLoadStore.mockResolvedValue(storeOf(largeSpacesArray));

      const startTime = performance.now();
      await listSpaces();
      const endTime = performance.now();

      const executionTime = endTime - startTime;
      expect(executionTime).toBeLessThan(300); // Should complete within 300ms
    });
  });

  describe('Benchmarks', () => {
    it('should benchmark basic operations', async () => {
      mockLoadStore.mockResolvedValue(storeOf([]));

      const benchmarks = {
        listSpaces: 0,
        loadStore: 0
      };

      // Benchmark listSpaces
      const listSpacesStart = performance.now();
      await listSpaces();
      benchmarks.listSpaces = performance.now() - listSpacesStart;

      // Benchmark the underlying store load
      const loadStoreStart = performance.now();
      await loadStore();
      benchmarks.loadStore = performance.now() - loadStoreStart;

      // Log benchmarks for analysis
      console.log('Performance Benchmarks:', benchmarks);

      // Verify reasonable performance thresholds
      expect(benchmarks.listSpaces).toBeLessThan(50);
      expect(benchmarks.loadStore).toBeLessThan(10);
    });
  });
});
