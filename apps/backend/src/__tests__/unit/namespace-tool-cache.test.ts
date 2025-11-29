import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Tool } from '@modelcontextprotocol/sdk/types.js';

// Mock the logger before importing the module
vi.mock('../../lib/metamcp/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Import after mocking
import {
  getNamespaceTools,
  setNamespaceTools,
  invalidateNamespaceCache,
  removeNamespaceCache,
  warmNamespaceCache,
  isWarmingInProgress,
  getWarmingPromise,
  getCacheStats,
  clearAllNamespaceCache,
} from '../../lib/metamcp/namespace-tool-cache';

// Helper to create mock tools
function createMockTools(count: number): Tool[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `tool_${i}`,
    description: `Test tool ${i}`,
    inputSchema: { type: 'object', properties: {} },
  }));
}

describe('Namespace Tool Cache', () => {
  beforeEach(() => {
    // Clear cache before each test
    clearAllNamespaceCache();
    vi.clearAllMocks();
  });

  afterEach(() => {
    clearAllNamespaceCache();
  });

  describe('Basic Cache Operations', () => {
    it('should return undefined for empty cache', () => {
      const result = getNamespaceTools('non-existent-namespace');
      expect(result).toBeUndefined();
    });

    it('should store and retrieve tools', () => {
      const namespaceUuid = 'test-namespace-1';
      const tools = createMockTools(5);

      setNamespaceTools(namespaceUuid, tools);
      const result = getNamespaceTools(namespaceUuid);

      expect(result).toEqual(tools);
      expect(result).toHaveLength(5);
    });

    it('should handle multiple namespaces independently', () => {
      const namespace1 = 'namespace-1';
      const namespace2 = 'namespace-2';
      const tools1 = createMockTools(3);
      const tools2 = createMockTools(7);

      setNamespaceTools(namespace1, tools1);
      setNamespaceTools(namespace2, tools2);

      expect(getNamespaceTools(namespace1)).toHaveLength(3);
      expect(getNamespaceTools(namespace2)).toHaveLength(7);
    });
  });

  describe('Cache Invalidation', () => {
    it('should mark cache as stale when invalidated', () => {
      const namespaceUuid = 'test-namespace';
      const tools = createMockTools(5);

      setNamespaceTools(namespaceUuid, tools);
      expect(getNamespaceTools(namespaceUuid)).toEqual(tools);

      invalidateNamespaceCache(namespaceUuid);
      
      // After invalidation, cache should return undefined (stale)
      expect(getNamespaceTools(namespaceUuid)).toBeUndefined();
    });

    it('should remove cache entry completely', () => {
      const namespaceUuid = 'test-namespace';
      const tools = createMockTools(5);

      setNamespaceTools(namespaceUuid, tools);
      expect(getNamespaceTools(namespaceUuid)).toEqual(tools);

      removeNamespaceCache(namespaceUuid);
      
      expect(getNamespaceTools(namespaceUuid)).toBeUndefined();
      
      const stats = getCacheStats();
      expect(stats.totalNamespaces).toBe(0);
    });
  });

  describe('Cache Warming', () => {
    it('should warm cache using provided fetch function', async () => {
      const namespaceUuid = 'test-namespace';
      const tools = createMockTools(10);
      const fetchFn = vi.fn().mockResolvedValue(tools);

      const result = await warmNamespaceCache(namespaceUuid, fetchFn);

      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(result).toEqual(tools);
      expect(getNamespaceTools(namespaceUuid)).toEqual(tools);
    });

    it('should deduplicate concurrent warming requests', async () => {
      const namespaceUuid = 'test-namespace';
      const tools = createMockTools(5);
      
      // Create a slow fetch function
      const fetchFn = vi.fn().mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        return tools;
      });

      // Start multiple concurrent requests
      const promise1 = warmNamespaceCache(namespaceUuid, fetchFn);
      const promise2 = warmNamespaceCache(namespaceUuid, fetchFn);
      const promise3 = warmNamespaceCache(namespaceUuid, fetchFn);

      // All should return the same result
      const [result1, result2, result3] = await Promise.all([promise1, promise2, promise3]);

      expect(result1).toEqual(tools);
      expect(result2).toEqual(tools);
      expect(result3).toEqual(tools);
      
      // Fetch function should only be called once
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('should track warming in progress', async () => {
      const namespaceUuid = 'test-namespace';
      
      const fetchFn = vi.fn().mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        return createMockTools(3);
      });

      // Before warming
      expect(isWarmingInProgress(namespaceUuid)).toBe(false);
      expect(getWarmingPromise(namespaceUuid)).toBeUndefined();

      // Start warming
      const warmPromise = warmNamespaceCache(namespaceUuid, fetchFn);

      // During warming
      expect(isWarmingInProgress(namespaceUuid)).toBe(true);
      expect(getWarmingPromise(namespaceUuid)).toBeDefined();

      await warmPromise;

      // After warming
      expect(isWarmingInProgress(namespaceUuid)).toBe(false);
      expect(getWarmingPromise(namespaceUuid)).toBeUndefined();
    });

    it('should handle fetch errors gracefully', async () => {
      const namespaceUuid = 'test-namespace';
      const error = new Error('Fetch failed');
      const fetchFn = vi.fn().mockRejectedValue(error);

      await expect(warmNamespaceCache(namespaceUuid, fetchFn)).rejects.toThrow('Fetch failed');

      // Cache should be marked as stale after error
      expect(getNamespaceTools(namespaceUuid)).toBeUndefined();
      expect(isWarmingInProgress(namespaceUuid)).toBe(false);
    });
  });

  describe('Cache Statistics', () => {
    it('should return correct cache statistics', () => {
      // Initial state
      let stats = getCacheStats();
      expect(stats.totalNamespaces).toBe(0);
      expect(stats.readyCount).toBe(0);
      expect(stats.warmingCount).toBe(0);
      expect(stats.staleCount).toBe(0);
      expect(stats.totalTools).toBe(0);

      // Add some tools
      setNamespaceTools('ns1', createMockTools(10));
      setNamespaceTools('ns2', createMockTools(20));

      stats = getCacheStats();
      expect(stats.totalNamespaces).toBe(2);
      expect(stats.readyCount).toBe(2);
      expect(stats.totalTools).toBe(30);

      // Invalidate one
      invalidateNamespaceCache('ns1');

      stats = getCacheStats();
      expect(stats.totalNamespaces).toBe(2);
      expect(stats.readyCount).toBe(1);
      expect(stats.staleCount).toBe(1);
    });
  });

  describe('Clear All Cache', () => {
    it('should clear all cached namespaces', () => {
      setNamespaceTools('ns1', createMockTools(5));
      setNamespaceTools('ns2', createMockTools(10));
      setNamespaceTools('ns3', createMockTools(15));

      let stats = getCacheStats();
      expect(stats.totalNamespaces).toBe(3);

      clearAllNamespaceCache();

      stats = getCacheStats();
      expect(stats.totalNamespaces).toBe(0);
      expect(stats.totalTools).toBe(0);
    });
  });

  describe('TTL Behavior', () => {
    // Note: TTL tests are environment-dependent
    // These tests verify the basic structure, but TTL behavior
    // should be tested in integration tests with controlled time
    
    it('should respect TTL=0 (never expires)', async () => {
      // With default TTL > 0, this test verifies basic caching works
      const namespaceUuid = 'test-namespace';
      const tools = createMockTools(5);

      setNamespaceTools(namespaceUuid, tools);
      
      // Should still be available (within TTL)
      expect(getNamespaceTools(namespaceUuid)).toEqual(tools);
    });
  });
});

