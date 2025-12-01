// Set environment variables before any imports to prevent database initialization
process.env.DATABASE_URL = 'test-database-url';
process.env.NODE_ENV = 'test';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Tool } from '@modelcontextprotocol/sdk/types.js';

// ============================================================================
// Mocks - Must be before imports that use them
// ============================================================================

// Mock the database module to prevent actual DB connection
vi.mock('../../db', () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    execute: vi.fn().mockResolvedValue([]),
  },
}));

// Mock the logger
vi.mock('../../lib/metamcp/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock the mcpServerPool
const mockInvalidateActiveSession = vi.fn().mockResolvedValue(undefined);
const mockInvalidateIdleSession = vi.fn().mockResolvedValue(undefined);
const mockGetSession = vi.fn();

vi.mock('../../lib/metamcp/mcp-server-pool', () => ({
  mcpServerPool: {
    getSession: (...args: unknown[]) => mockGetSession(...args),
    invalidateActiveSession: (...args: unknown[]) => mockInvalidateActiveSession(...args),
    invalidateIdleSession: (...args: unknown[]) => mockInvalidateIdleSession(...args),
  },
}));

// Mock getMcpServers
vi.mock('../../lib/metamcp/fetch-metamcp', () => ({
  getMcpServers: vi.fn().mockResolvedValue({}),
}));

// Mock toolsImplementations
vi.mock('../../trpc/tools.impl', () => ({
  toolsImplementations: {
    create: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock mapOverrideNameToOriginal
vi.mock('../../lib/metamcp/metamcp-middleware/tool-overrides.functional', () => ({
  mapOverrideNameToOriginal: vi.fn().mockImplementation((name: string) => Promise.resolve(name)),
}));

// Import after mocking
import { isSessionExpiredError, fetchAllToolsFromUpstream } from '../../lib/metamcp/tool-fetcher';
import { getMcpServers } from '../../lib/metamcp/fetch-metamcp';

// ============================================================================
// Test Helpers
// ============================================================================

function createMockTools(count: number, prefix: string = 'tool'): Tool[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `${prefix}_${i}`,
    description: `Test tool ${i}`,
    inputSchema: { type: 'object' as const, properties: {} },
  }));
}

function createMockSession(tools: Tool[] = []) {
  return {
    client: {
      getServerVersion: vi.fn().mockReturnValue({ name: 'test-server' }),
      getServerCapabilities: vi.fn().mockReturnValue({ tools: {} }),
      request: vi.fn().mockResolvedValue({
        tools,
        nextCursor: undefined,
      }),
    },
    cleanup: vi.fn().mockResolvedValue(undefined),
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('Tool Fetcher - Stale Session Handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('isSessionExpiredError', () => {
    it('should detect session_not_found error', () => {
      const error = new Error('Error POSTing to endpoint (HTTP 404): {"name":"session_not_found","message":"Invalid session ID"}');
      expect(isSessionExpiredError(error)).toBe(true);
    });

    it('should detect session_not_found in lowercase', () => {
      const error = new Error('Session_not_found error occurred');
      expect(isSessionExpiredError(error)).toBe(true);
    });

    it('should detect invalid session error', () => {
      const error = new Error('Invalid session detected');
      expect(isSessionExpiredError(error)).toBe(true);
    });

    it('should detect session expired error', () => {
      const error = new Error('Your session expired, please reconnect');
      expect(isSessionExpiredError(error)).toBe(true);
    });

    it('should detect session timeout error', () => {
      const error = new Error('Session timeout after 30 minutes');
      expect(isSessionExpiredError(error)).toBe(true);
    });

    it('should return false for non-session errors', () => {
      const error = new Error('Network connection failed');
      expect(isSessionExpiredError(error)).toBe(false);
    });

    it('should return false for authentication errors', () => {
      const error = new Error('Authentication required');
      expect(isSessionExpiredError(error)).toBe(false);
    });

    it('should return false for permission errors', () => {
      const error = new Error('Permission denied');
      expect(isSessionExpiredError(error)).toBe(false);
    });

    it('should return false for null/undefined errors', () => {
      expect(isSessionExpiredError(null)).toBe(false);
      expect(isSessionExpiredError(undefined)).toBe(false);
    });

    it('should return false for non-Error objects', () => {
      expect(isSessionExpiredError('string error')).toBe(false);
      expect(isSessionExpiredError({ message: 'session_not_found' })).toBe(false);
      expect(isSessionExpiredError(123)).toBe(false);
    });
  });

  describe('fetchAllToolsFromUpstream - Session Expiry Retry', () => {
    const namespaceUuid = 'test-namespace';
    const sessionId = 'test-session';
    const serverUuid = 'server-uuid';
    const serverParams = {
      uuid: serverUuid,
      name: 'TestServer',
      type: 'stdio' as const,
      command: 'test',
      args: [],
    };

    beforeEach(() => {
      vi.mocked(getMcpServers).mockResolvedValue({
        [serverUuid]: serverParams,
      });
    });

    it('should fetch tools successfully without retry on normal request', async () => {
      const tools = createMockTools(3);
      const mockSession = createMockSession(tools);
      mockGetSession.mockResolvedValue(mockSession);

      const result = await fetchAllToolsFromUpstream(namespaceUuid, sessionId);

      expect(result.tools).toHaveLength(3);
      expect(mockGetSession).toHaveBeenCalledTimes(1);
      expect(mockInvalidateActiveSession).not.toHaveBeenCalled();
      expect(mockInvalidateIdleSession).not.toHaveBeenCalled();
    });

    it('should retry once on session_not_found error', async () => {
      const tools = createMockTools(5);
      
      // First session throws session_not_found
      const staleSession = {
        client: {
          getServerVersion: vi.fn().mockReturnValue({ name: 'test-server' }),
          getServerCapabilities: vi.fn().mockReturnValue({ tools: {} }),
          request: vi.fn().mockRejectedValue(
            new Error('Error POSTing to endpoint (HTTP 404): {"name":"session_not_found","message":"Invalid session ID"}')
          ),
        },
        cleanup: vi.fn().mockResolvedValue(undefined),
      };

      // Fresh session works
      const freshSession = createMockSession(tools);

      // First call returns stale, second call returns fresh
      mockGetSession
        .mockResolvedValueOnce(staleSession)
        .mockResolvedValueOnce(freshSession);

      const result = await fetchAllToolsFromUpstream(namespaceUuid, sessionId);

      expect(result.tools).toHaveLength(5);
      // getSession called twice: once for initial, once for retry
      expect(mockGetSession).toHaveBeenCalledTimes(2);
      // Invalidation methods should be called
      expect(mockInvalidateActiveSession).toHaveBeenCalledWith(sessionId, serverUuid);
      expect(mockInvalidateIdleSession).toHaveBeenCalledWith(serverUuid, serverParams, namespaceUuid);
    });

    it('should not retry more than once on repeated session errors', async () => {
      // Both sessions throw session_not_found
      const staleSession = {
        client: {
          getServerVersion: vi.fn().mockReturnValue({ name: 'test-server' }),
          getServerCapabilities: vi.fn().mockReturnValue({ tools: {} }),
          request: vi.fn().mockRejectedValue(
            new Error('session_not_found')
          ),
        },
        cleanup: vi.fn().mockResolvedValue(undefined),
      };

      mockGetSession.mockResolvedValue(staleSession);

      const result = await fetchAllToolsFromUpstream(namespaceUuid, sessionId);

      // Should still return empty tools (error is caught, not propagated)
      expect(result.tools).toHaveLength(0);
      // getSession called twice: once for initial, once for retry
      expect(mockGetSession).toHaveBeenCalledTimes(2);
      // Invalidation should still be called (only on first failure)
      expect(mockInvalidateActiveSession).toHaveBeenCalledTimes(1);
    });

    it('should not retry on non-session errors', async () => {
      const networkErrorSession = {
        client: {
          getServerVersion: vi.fn().mockReturnValue({ name: 'test-server' }),
          getServerCapabilities: vi.fn().mockReturnValue({ tools: {} }),
          request: vi.fn().mockRejectedValue(
            new Error('Network connection refused')
          ),
        },
        cleanup: vi.fn().mockResolvedValue(undefined),
      };

      mockGetSession.mockResolvedValue(networkErrorSession);

      const result = await fetchAllToolsFromUpstream(namespaceUuid, sessionId);

      // Should return empty tools (error is caught)
      expect(result.tools).toHaveLength(0);
      // getSession called only once (no retry for non-session errors)
      expect(mockGetSession).toHaveBeenCalledTimes(1);
      // Invalidation should NOT be called
      expect(mockInvalidateActiveSession).not.toHaveBeenCalled();
      expect(mockInvalidateIdleSession).not.toHaveBeenCalled();
    });

    it('should handle server without tools capability gracefully', async () => {
      const noToolsSession = {
        client: {
          getServerVersion: vi.fn().mockReturnValue({ name: 'no-tools-server' }),
          getServerCapabilities: vi.fn().mockReturnValue({}), // No tools capability
          request: vi.fn(),
        },
        cleanup: vi.fn().mockResolvedValue(undefined),
      };

      mockGetSession.mockResolvedValue(noToolsSession);

      const result = await fetchAllToolsFromUpstream(namespaceUuid, sessionId);

      expect(result.tools).toHaveLength(0);
      // request should not be called if no tools capability
      expect(noToolsSession.client.request).not.toHaveBeenCalled();
    });

    it('should handle paginated tool responses', async () => {
      const page1Tools = createMockTools(2, 'page1');
      const page2Tools = createMockTools(2, 'page2');
      
      const paginatedSession = {
        client: {
          getServerVersion: vi.fn().mockReturnValue({ name: 'test-server' }),
          getServerCapabilities: vi.fn().mockReturnValue({ tools: {} }),
          request: vi.fn()
            .mockResolvedValueOnce({ tools: page1Tools, nextCursor: 'cursor-1' })
            .mockResolvedValueOnce({ tools: page2Tools, nextCursor: undefined }),
        },
        cleanup: vi.fn().mockResolvedValue(undefined),
      };

      mockGetSession.mockResolvedValue(paginatedSession);

      const result = await fetchAllToolsFromUpstream(namespaceUuid, sessionId);

      // Should have tools from both pages (with server prefix)
      expect(result.tools).toHaveLength(4);
      // request should be called twice (for both pages)
      expect(paginatedSession.client.request).toHaveBeenCalledTimes(2);
    });

    it('should handle session_not_found during pagination', async () => {
      const page1Tools = createMockTools(2, 'page1');
      const allTools = createMockTools(5, 'all');
      
      // First session fails on second page
      const failingSession = {
        client: {
          getServerVersion: vi.fn().mockReturnValue({ name: 'test-server' }),
          getServerCapabilities: vi.fn().mockReturnValue({ tools: {} }),
          request: vi.fn()
            .mockResolvedValueOnce({ tools: page1Tools, nextCursor: 'cursor-1' })
            .mockRejectedValueOnce(new Error('session_not_found')),
        },
        cleanup: vi.fn().mockResolvedValue(undefined),
      };

      // Fresh session works
      const freshSession = createMockSession(allTools);

      mockGetSession
        .mockResolvedValueOnce(failingSession)
        .mockResolvedValueOnce(freshSession);

      const result = await fetchAllToolsFromUpstream(namespaceUuid, sessionId);

      // Should have tools from fresh session (full retry)
      expect(result.tools).toHaveLength(5);
      // Invalidation should be called
      expect(mockInvalidateActiveSession).toHaveBeenCalled();
    });
  });

  describe('McpServerPool Integration', () => {
    it('should call invalidateActiveSession with correct parameters', async () => {
      const serverUuid = 'server-uuid';
      const serverParams = {
        uuid: serverUuid,
        name: 'TestServer',
        type: 'stdio' as const,
        command: 'test',
        args: [],
      };

      vi.mocked(getMcpServers).mockResolvedValue({
        [serverUuid]: serverParams,
      });

      const staleSession = {
        client: {
          getServerVersion: vi.fn().mockReturnValue({ name: 'test-server' }),
          getServerCapabilities: vi.fn().mockReturnValue({ tools: {} }),
          request: vi.fn().mockRejectedValue(new Error('session_not_found')),
        },
        cleanup: vi.fn().mockResolvedValue(undefined),
      };

      const freshSession = createMockSession(createMockTools(1));

      mockGetSession
        .mockResolvedValueOnce(staleSession)
        .mockResolvedValueOnce(freshSession);

      await fetchAllToolsFromUpstream('test-namespace', 'test-session');

      expect(mockInvalidateActiveSession).toHaveBeenCalledWith(
        'test-session',
        serverUuid
      );

      expect(mockInvalidateIdleSession).toHaveBeenCalledWith(
        serverUuid,
        serverParams,
        'test-namespace'
      );
    });
  });
});

