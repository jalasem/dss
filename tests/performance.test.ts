import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { performance } from 'perf_hooks';
import { addSpace, listSpaces, switchSpace } from '../src/utils/SpaceManager';

// Mock external dependencies for performance tests
jest.mock('child_process');
jest.mock('@inquirer/prompts');
jest.mock('../src/utils/sshKeyGen');
jest.mock('../src/utils/index');

describe('Performance Tests', () => {
  const mockHomeDir = '/mock/home';
  const mockConfigPath = path.join(mockHomeDir, '.dss', 'spaces', 'config.json');

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(os, 'homedir').mockReturnValue(mockHomeDir);
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
  });

  describe('Space Operations Performance', () => {
    it('should list spaces quickly even with many spaces', async () => {
      const mockSpaces = Array.from({ length: 100 }, (_, i) => ({
        name: `space-${i}`,
        email: `user${i}@example.com`,
        userName: `User ${i}`,
        sshKeyPath: `/mock/path/space-${i}/id_rsa`
      }));

      const mockFs = fs as jest.Mocked<typeof fs>;
      mockFs.ensureFile.mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ spaces: mockSpaces });

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

      const mockFs = fs as jest.Mocked<typeof fs>;
      mockFs.ensureFile.mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ spaces: [mockSpace] });
      mockFs.writeJson.mockResolvedValue();

      const { execSync } = require('child_process');
      execSync.mockImplementation(() => {});

      const { confirm } = require('@inquirer/prompts');
      confirm.mockResolvedValue(false);

      const startTime = performance.now();
      await switchSpace('test-space');
      const endTime = performance.now();

      const executionTime = endTime - startTime;
      expect(executionTime).toBeLessThan(200); // Should complete within 200ms
    });

    it('should handle configuration file operations efficiently', async () => {
      const mockFs = fs as jest.Mocked<typeof fs>;
      mockFs.ensureFile.mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ spaces: [] });
      mockFs.writeJson.mockResolvedValue();

      const operations = [];
      const startTime = performance.now();

      // Simulate multiple rapid configuration operations
      for (let i = 0; i < 10; i++) {
        operations.push(mockFs.ensureFile(mockConfigPath));
        operations.push(mockFs.readJson(mockConfigPath));
        operations.push(mockFs.writeJson(mockConfigPath, { spaces: [] }));
      }

      await Promise.all(operations);
      const endTime = performance.now();

      const executionTime = endTime - startTime;
      expect(executionTime).toBeLessThan(50); // Should complete within 50ms
    });
  });

  describe('Memory Usage Tests', () => {
    it('should not leak memory during repeated operations', async () => {
      const mockFs = fs as jest.Mocked<typeof fs>;
      mockFs.ensureFile.mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ spaces: [] });

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
      const mockFs = fs as jest.Mocked<typeof fs>;
      mockFs.ensureFile.mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ spaces: [] });

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

      const mockFs = fs as jest.Mocked<typeof fs>;
      mockFs.ensureFile.mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ spaces: largeSpacesArray });

      const startTime = performance.now();
      await listSpaces();
      const endTime = performance.now();

      const executionTime = endTime - startTime;
      expect(executionTime).toBeLessThan(300); // Should complete within 300ms
    });
  });

  describe('Benchmarks', () => {
    it('should benchmark basic operations', async () => {
      const mockFs = fs as jest.Mocked<typeof fs>;
      mockFs.ensureFile.mockResolvedValue(undefined);
      mockFs.readJson.mockResolvedValue({ spaces: [] });

      const benchmarks = {
        listSpaces: 0,
        ensureFile: 0,
        readJson: 0
      };

      // Benchmark listSpaces
      const listSpacesStart = performance.now();
      await listSpaces();
      benchmarks.listSpaces = performance.now() - listSpacesStart;

      // Benchmark file operations
      const fileOpsStart = performance.now();
      await mockFs.ensureFile(mockConfigPath);
      benchmarks.ensureFile = performance.now() - fileOpsStart;

      const readJsonStart = performance.now();
      await mockFs.readJson(mockConfigPath);
      benchmarks.readJson = performance.now() - readJsonStart;

      // Log benchmarks for analysis
      console.log('Performance Benchmarks:', benchmarks);

      // Verify reasonable performance thresholds
      expect(benchmarks.listSpaces).toBeLessThan(50);
      expect(benchmarks.ensureFile).toBeLessThan(10);
      expect(benchmarks.readJson).toBeLessThan(10);
    });
  });
});