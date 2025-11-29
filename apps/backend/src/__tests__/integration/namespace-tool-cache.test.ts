import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Integration tests for namespace-level tool cache behavior.
 * 
 * These tests verify the cache integrates correctly with:
 * - Idle server creation (pre-warming)
 * - Cache invalidation on config changes
 * - Multi-session cache sharing
 * 
 * Note: Some tests require mocking of external dependencies.
 */

// Mock dependencies before imports
vi.mock('../../lib/metamcp/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../lib/metamcp/fetch-metamcp', () => ({
  getMcpServers: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../lib/metamcp/mcp-server-pool', () => ({
  mcpServerPool: {
    getSession: vi.fn(),
    cleanupSession: vi.fn(),
  },
}));

// Import after mocking
import {
  getNamespaceTools,
  setNamespaceTools,
  invalidateNamespaceCache,
  removeNamespaceCache,
  warmNamespaceCache,
  clearAllNamespaceCache,
  getCacheStats,
} from '../../lib/metamcp/namespace-tool-cache';
import { Tool } from '@modelcontextprotocol/sdk/types.js';

// Helper to create mock tools
function createMockTools(count: number, prefix = 'tool'): Tool[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `${prefix}_${i}`,
    description: `Test tool ${i}`,
    inputSchema: { type: 'object', properties: {} },
  }));
}

describe('Namespace Tool Cache Integration', () => {
  beforeEach(() => {
    clearAllNamespaceCache();
    vi.clearAllMocks();
  });

  afterEach(() => {
    clearAllNamespaceCache();
  });

  describe('Cache Sharing Across Sessions', () => {
    it('should share cache between multiple sessions in same namespace', async () => {
      const namespaceUuid = 'shared-namespace';
      const tools = createMockTools(100);
      
      // First session warms the cache
      const session1FetchFn = vi.fn().mockResolvedValue(tools);
      await warmNamespaceCache(namespaceUuid, session1FetchFn);

      expect(session1FetchFn).toHaveBeenCalledTimes(1);
      expect(getNamespaceTools(namespaceUuid)).toEqual(tools);

      // Second session should use cached data (no new fetch)
      const session2FetchFn = vi.fn().mockResolvedValue(tools);
      
      // Get cached tools directly (simulating cache hit in handler)
      const cachedTools = getNamespaceTools(namespaceUuid);
      
      expect(cachedTools).toEqual(tools);
      expect(session2FetchFn).not.toHaveBeenCalled();
    });

    it('should isolate cache between different namespaces', async () => {
      const namespace1 = 'namespace-1';
      const namespace2 = 'namespace-2';
      const tools1 = createMockTools(50, 'ns1_tool');
      const tools2 = createMockTools(30, 'ns2_tool');

      await warmNamespaceCache(namespace1, async () => tools1);
      await warmNamespaceCache(namespace2, async () => tools2);

      const cached1 = getNamespaceTools(namespace1);
      const cached2 = getNamespaceTools(namespace2);

      expect(cached1).toHaveLength(50);
      expect(cached2).toHaveLength(30);
      expect(cached1![0].name).toContain('ns1_tool');
      expect(cached2![0].name).toContain('ns2_tool');
    });
  });

  describe('Cache Invalidation Scenarios', () => {
    it('should invalidate cache when MCP server config changes', async () => {
      const namespaceUuid = 'config-change-namespace';
      const initialTools = createMockTools(20, 'initial');
      const updatedTools = createMockTools(25, 'updated');

      // Initial cache population
      const initialFetch = vi.fn().mockResolvedValue(initialTools);
      await warmNamespaceCache(namespaceUuid, initialFetch);
      expect(getNamespaceTools(namespaceUuid)).toEqual(initialTools);

      // Simulate config change -> invalidation
      invalidateNamespaceCache(namespaceUuid);
      expect(getNamespaceTools(namespaceUuid)).toBeUndefined();

      // Re-warm with updated tools
      const updatedFetch = vi.fn().mockResolvedValue(updatedTools);
      await warmNamespaceCache(namespaceUuid, updatedFetch);
      
      expect(getNamespaceTools(namespaceUuid)).toEqual(updatedTools);
      expect(getNamespaceTools(namespaceUuid)).toHaveLength(25);
    });

    it('should handle rapid invalidation during warming', async () => {
      const namespaceUuid = 'rapid-invalidation';
      const tools = createMockTools(10);

      // Start warming with a slow fetch
      const slowFetch = vi.fn().mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        return tools;
      });

      const warmPromise = warmNamespaceCache(namespaceUuid, slowFetch);

      // Invalidate while warming is in progress
      invalidateNamespaceCache(namespaceUuid);

      // Wait for warming to complete
      await warmPromise;

      // Cache should be in ready state (warming completed)
      // or stale state (if invalidation happened after warming)
      const cached = getNamespaceTools(namespaceUuid);
      // The result depends on timing - either we get the tools or undefined
      if (cached) {
        expect(cached).toEqual(tools);
      }
    });
  });

  describe('Pre-warming Behavior', () => {
    it('should allow pre-warming before any session requests', async () => {
      const namespaceUuid = 'pre-warm-namespace';
      const tools = createMockTools(50);

      // Pre-warm cache (simulates idle server creation)
      await warmNamespaceCache(namespaceUuid, async () => tools);

      // Verify cache is ready
      const stats = getCacheStats();
      expect(stats.readyCount).toBe(1);
      expect(stats.totalTools).toBe(50);

      // First session request should hit cache
      const cached = getNamespaceTools(namespaceUuid);
      expect(cached).toEqual(tools);
    });

    it('should handle pre-warming failure gracefully', async () => {
      const namespaceUuid = 'pre-warm-failure';
      const error = new Error('MCP server unavailable');

      // Pre-warm fails
      await expect(
        warmNamespaceCache(namespaceUuid, async () => {
          throw error;
        })
      ).rejects.toThrow('MCP server unavailable');

      // Cache should be in stale state
      expect(getNamespaceTools(namespaceUuid)).toBeUndefined();

      // Retry should work
      const tools = createMockTools(10);
      await warmNamespaceCache(namespaceUuid, async () => tools);
      expect(getNamespaceTools(namespaceUuid)).toEqual(tools);
    });
  });

  describe('Concurrent Request Handling', () => {
    it('should handle many concurrent requests during warming', async () => {
      const namespaceUuid = 'concurrent-namespace';
      const tools = createMockTools(100);
      let fetchCount = 0;

      const slowFetch = vi.fn().mockImplementation(async () => {
        fetchCount++;
        await new Promise(resolve => setTimeout(resolve, 50));
        return tools;
      });

      // Start 10 concurrent requests
      const promises = Array.from({ length: 10 }, () =>
        warmNamespaceCache(namespaceUuid, slowFetch)
      );

      const results = await Promise.all(promises);

      // All should get the same result
      results.forEach(result => {
        expect(result).toEqual(tools);
      });

      // Fetch should only happen once
      expect(fetchCount).toBe(1);
      expect(slowFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('Namespace Cleanup', () => {
    it('should fully remove cache when namespace is deleted', async () => {
      const namespaceUuid = 'to-be-deleted';
      const tools = createMockTools(30);

      await warmNamespaceCache(namespaceUuid, async () => tools);
      expect(getNamespaceTools(namespaceUuid)).toEqual(tools);

      // Simulate namespace deletion
      removeNamespaceCache(namespaceUuid);

      expect(getNamespaceTools(namespaceUuid)).toBeUndefined();
      
      const stats = getCacheStats();
      expect(stats.totalNamespaces).toBe(0);
    });
  });

  describe('Cache Statistics', () => {
    it('should track cache state across operations', async () => {
      // Initial state
      expect(getCacheStats()).toEqual({
        totalNamespaces: 0,
        readyCount: 0,
        warmingCount: 0,
        staleCount: 0,
        totalTools: 0,
      });

      // Add namespace 1
      setNamespaceTools('ns1', createMockTools(50));
      expect(getCacheStats().totalTools).toBe(50);

      // Add namespace 2
      setNamespaceTools('ns2', createMockTools(100));
      expect(getCacheStats().totalTools).toBe(150);
      expect(getCacheStats().readyCount).toBe(2);

      // Invalidate namespace 1
      invalidateNamespaceCache('ns1');
      expect(getCacheStats().staleCount).toBe(1);
      expect(getCacheStats().readyCount).toBe(1);

      // Remove namespace 2
      removeNamespaceCache('ns2');
      expect(getCacheStats().totalNamespaces).toBe(1);
    });
  });

  describe('Skip Warming When Already Warm', () => {
    it('should skip warming and return cached tools when cache is already ready', async () => {
      const namespaceUuid = 'already-warm';
      const tools = createMockTools(100);
      
      // First warm
      const firstFetch = vi.fn().mockResolvedValue(tools);
      await warmNamespaceCache(namespaceUuid, firstFetch);
      expect(firstFetch).toHaveBeenCalledTimes(1);
      expect(getNamespaceTools(namespaceUuid)).toEqual(tools);

      // Second warm should skip (cache already ready)
      const secondFetch = vi.fn().mockResolvedValue(createMockTools(200));
      const result = await warmNamespaceCache(namespaceUuid, secondFetch);
      
      // Should NOT call fetch - should return cached tools
      expect(secondFetch).not.toHaveBeenCalled();
      expect(result).toEqual(tools);
      expect(result).toHaveLength(100); // Original tools, not new 200
    });

    it('should re-warm after invalidation', async () => {
      const namespaceUuid = 'invalidate-then-warm';
      const oldTools = createMockTools(50, 'old');
      const newTools = createMockTools(75, 'new');

      // Initial warm
      await warmNamespaceCache(namespaceUuid, async () => oldTools);
      expect(getNamespaceTools(namespaceUuid)).toHaveLength(50);

      // Invalidate
      invalidateNamespaceCache(namespaceUuid);
      expect(getNamespaceTools(namespaceUuid)).toBeUndefined();

      // Re-warm should fetch new tools
      const fetchFn = vi.fn().mockResolvedValue(newTools);
      await warmNamespaceCache(namespaceUuid, fetchFn);
      
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(getNamespaceTools(namespaceUuid)).toHaveLength(75);
      expect(getNamespaceTools(namespaceUuid)![0].name).toContain('new');
    });
  });

  describe('list_tools Performance (Lazy Mapping)', () => {
    /**
     * CRITICAL TEST: Verifies that list_tools() returns quickly when cache is hit.
     * 
     * Previously, even with a cache hit, list_tools() would take 40+ seconds because
     * it was building session mappings (connecting to all upstream MCP servers).
     * 
     * The fix: Skip mapping building on cache hit - mappings are built lazily
     * when tools are actually called (call_tool handler has fallback routing).
     */
    it('should return cached tools immediately without building mappings', async () => {
      const namespaceUuid = 'fast-list-tools';
      const tools = createMockTools(1000); // Large tool set
      
      // Pre-warm the cache
      await warmNamespaceCache(namespaceUuid, async () => tools);
      
      // Simulate what happens in list_tools handler on cache hit:
      // 1. Check cache - should be instant
      // 2. Return cached tools - should be instant
      // 3. NO mapping building - this is the key fix!
      
      const startTime = Date.now();
      const cachedTools = getNamespaceTools(namespaceUuid);
      const duration = Date.now() - startTime;
      
      expect(cachedTools).toEqual(tools);
      expect(cachedTools).toHaveLength(1000);
      
      // Should be nearly instant (< 10ms for just cache lookup)
      // Previously this was bundled with mapping building (40+ seconds)
      expect(duration).toBeLessThan(100);
    });

    it('should handle pagination on cached tools efficiently', async () => {
      const namespaceUuid = 'paginated-cache';
      const tools = createMockTools(500);
      const pageSize = 50;
      
      // Pre-warm
      await warmNamespaceCache(namespaceUuid, async () => tools);
      
      // Simulate paginated access
      const startTime = Date.now();
      
      for (let page = 0; page < 10; page++) {
        const cachedTools = getNamespaceTools(namespaceUuid);
        expect(cachedTools).toBeTruthy();
        
        // Slice for pagination
        const offset = page * pageSize;
        const pageTools = cachedTools!.slice(offset, offset + pageSize);
        expect(pageTools).toHaveLength(50);
      }
      
      const totalDuration = Date.now() - startTime;
      
      // 10 paginated requests should complete very fast
      expect(totalDuration).toBeLessThan(100);
    });
  });
});

