import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { logger } from "./logger";

// ============================================================================
// Namespace-Level Tool Cache
// ============================================================================
// This cache stores aggregated tools at the namespace level, enabling:
// 1. Cache sharing across all sessions in a namespace
// 2. Pre-warming when idle servers are created
// 3. Fast list_tools() responses (~50ms vs 38-39s)
// ============================================================================

type CacheStatus = "warming" | "ready" | "stale";

interface NamespaceToolCacheEntry {
  tools: Tool[];
  timestamp: number;
  status: CacheStatus;
}

/**
 * Namespace-level tool cache.
 * Key: namespaceUuid
 * Value: { tools, timestamp, status }
 */
const namespaceToolCache: Map<string, NamespaceToolCacheEntry> = new Map();

/**
 * Track in-progress warming promises to deduplicate concurrent requests.
 * Key: namespaceUuid
 * Value: Promise that resolves to tools
 */
const warmingPromises: Map<string, Promise<Tool[]>> = new Map();

/**
 * Default TTL for cached tools (1 hour in milliseconds).
 * Can be overridden via MCP_TOOLS_CACHE_TTL env var (in seconds).
 */
const DEFAULT_CACHE_TTL_MS = 3600 * 1000; // 1 hour

/**
 * Get configured cache TTL in milliseconds.
 */
function getCacheTTL(): number {
  const envTTL = process.env.MCP_TOOLS_CACHE_TTL;
  if (envTTL) {
    const parsed = parseInt(envTTL, 10);
    if (!isNaN(parsed) && parsed >= 0) {
      return parsed * 1000; // Convert seconds to milliseconds
    }
  }
  return DEFAULT_CACHE_TTL_MS;
}

/**
 * Check if a cache entry is stale (expired based on TTL).
 */
function isStale(entry: NamespaceToolCacheEntry): boolean {
  const ttl = getCacheTTL();
  // TTL=0 means never expires (until explicitly invalidated)
  if (ttl === 0) {
    return entry.status === "stale";
  }
  const age = Date.now() - entry.timestamp;
  return age > ttl || entry.status === "stale";
}

/**
 * Get cached tools for a namespace.
 * Returns undefined if cache miss or stale.
 */
export function getNamespaceTools(namespaceUuid: string): Tool[] | undefined {
  const entry = namespaceToolCache.get(namespaceUuid);
  
  // Debug: Log cache state with console.log for visibility
  const cacheKeys = Array.from(namespaceToolCache.keys());
  console.log(`[DEBUG ToolCache] getNamespaceTools called with: ${namespaceUuid}`);
  console.log(`[DEBUG ToolCache] Cache keys: [${cacheKeys.join(', ')}]`);
  console.log(`[DEBUG ToolCache] Cache size: ${namespaceToolCache.size}`);
  
  if (!entry) {
    console.log(`[DEBUG ToolCache] MISS: No entry found for ${namespaceUuid}`);
    return undefined;
  }
  
  console.log(`[DEBUG ToolCache] Entry found: status=${entry.status}, tools=${entry.tools.length}, age=${Date.now() - entry.timestamp}ms`);
  
  if (isStale(entry)) {
    console.log(`[DEBUG ToolCache] STALE: Entry is stale for ${namespaceUuid}`);
    return undefined;
  }
  if (entry.status !== "ready") {
    console.log(`[DEBUG ToolCache] NOT READY: status=${entry.status}`);
    return undefined;
  }
  
  console.log(`[DEBUG ToolCache] HIT: Returning ${entry.tools.length} tools for ${namespaceUuid}`);
  return entry.tools;
}

/**
 * Set cached tools for a namespace.
 */
export function setNamespaceTools(namespaceUuid: string, tools: Tool[]): void {
  console.log(`[DEBUG ToolCache] setNamespaceTools called with namespaceUuid: ${namespaceUuid}, tools: ${tools.length}`);
  namespaceToolCache.set(namespaceUuid, {
    tools,
    timestamp: Date.now(),
    status: "ready",
  });
  console.log(`[DEBUG ToolCache] Cache SET: ${tools.length} tools for ${namespaceUuid}`);
  console.log(`[DEBUG ToolCache] Cache size after set: ${namespaceToolCache.size}`);
}

/**
 * Invalidate cache for a namespace.
 * Marks as stale, will be re-fetched on next request.
 */
export function invalidateNamespaceCache(namespaceUuid: string): void {
  const entry = namespaceToolCache.get(namespaceUuid);
  if (entry) {
    entry.status = "stale";
    logger.debug("ToolCache", `Invalidated cache for namespace ${namespaceUuid.slice(0, 8)}...`);
  }
  // Also cancel any in-progress warming (it will be re-triggered)
  warmingPromises.delete(namespaceUuid);
}

/**
 * Remove cache entry for a namespace entirely.
 * Use when namespace is deleted.
 */
export function removeNamespaceCache(namespaceUuid: string): void {
  namespaceToolCache.delete(namespaceUuid);
  warmingPromises.delete(namespaceUuid);
  logger.debug("ToolCache", `Removed cache for namespace ${namespaceUuid.slice(0, 8)}...`);
}

/**
 * Check if warming is in progress for a namespace.
 */
export function isWarmingInProgress(namespaceUuid: string): boolean {
  return warmingPromises.has(namespaceUuid);
}

/**
 * Get the warming promise if one exists.
 * Allows callers to wait for an in-progress warm operation.
 */
export function getWarmingPromise(namespaceUuid: string): Promise<Tool[]> | undefined {
  return warmingPromises.get(namespaceUuid);
}

/**
 * Warm the namespace cache by fetching tools from upstream.
 * Deduplicates concurrent requests - if warming is already in progress,
 * returns the existing promise instead of starting a new fetch.
 * 
 * @param namespaceUuid - The namespace to warm cache for
 * @param fetchFn - Function that fetches all tools from upstream servers
 * @returns Promise resolving to the fetched tools
 */
export async function warmNamespaceCache(
  namespaceUuid: string,
  fetchFn: () => Promise<Tool[]>,
): Promise<Tool[]> {
  // First, check if cache is already warm and valid - no need to re-warm!
  const existingEntry = namespaceToolCache.get(namespaceUuid);
  if (existingEntry?.status === "ready" && !isStale(existingEntry)) {
    console.log(`[ToolCache] Cache already warm for ${namespaceUuid.slice(0, 8)}... (${existingEntry.tools.length} tools, age=${Date.now() - existingEntry.timestamp}ms), skipping warm`);
    return existingEntry.tools;
  }

  // Check if warming is already in progress (by promise)
  const existingPromise = warmingPromises.get(namespaceUuid);
  if (existingPromise) {
    console.log(`[ToolCache] Warming already in progress (promise found) for ${namespaceUuid.slice(0, 8)}..., waiting`);
    return existingPromise;
  }

  // Also check cache status - handles race condition where cache entry is set
  // but promise is not yet stored
  if (existingEntry?.status === "warming") {
    // Wait briefly for the promise to be stored, then retry
    console.log(`[ToolCache] Cache shows warming but no promise yet for ${namespaceUuid.slice(0, 8)}..., waiting 100ms`);
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Retry - the promise should be stored now
    const retryPromise = warmingPromises.get(namespaceUuid);
    if (retryPromise) {
      console.log(`[ToolCache] Found promise after retry for ${namespaceUuid.slice(0, 8)}...`);
      return retryPromise;
    }
    
    // If still no promise but status is warming, it might have completed
    const retryEntry = namespaceToolCache.get(namespaceUuid);
    if (retryEntry?.status === "ready") {
      console.log(`[ToolCache] Cache became ready during wait for ${namespaceUuid.slice(0, 8)}...`);
      return retryEntry.tools;
    }
    
    // Status still warming but no promise - something went wrong, proceed with new warm
    console.log(`[ToolCache] No promise found after retry for ${namespaceUuid.slice(0, 8)}..., starting new warm`);
  }

  // Mark as warming BEFORE creating the promise to minimize race window
  namespaceToolCache.set(namespaceUuid, {
    tools: [],
    timestamp: Date.now(),
    status: "warming",
  });

  // Create the warming promise
  const warmPromise = (async () => {
    try {
      console.log(`[ToolCache] Starting fetch for namespace ${namespaceUuid.slice(0, 8)}...`);
      const startTime = Date.now();
      
      const tools = await fetchFn();
      
      const duration = Date.now() - startTime;
      console.log(`[ToolCache] Warmed cache: ${tools.length} tools in ${duration}ms`);
      
      // Update cache with fetched tools
      setNamespaceTools(namespaceUuid, tools);
      
      return tools;
    } catch (error) {
      // On error, mark as stale so next request retries
      logger.error("ToolCache", `Warming failed for ${namespaceUuid.slice(0, 8)}...`, error);
      invalidateNamespaceCache(namespaceUuid);
      throw error;
    } finally {
      // Always clean up the warming promise
      warmingPromises.delete(namespaceUuid);
    }
  })();

  // Store promise IMMEDIATELY after creation
  warmingPromises.set(namespaceUuid, warmPromise);
  console.log(`[ToolCache] Stored warming promise for ${namespaceUuid.slice(0, 8)}...`);
  
  return warmPromise;
}

/**
 * Get cache statistics for monitoring.
 */
export function getCacheStats(): {
  totalNamespaces: number;
  readyCount: number;
  warmingCount: number;
  staleCount: number;
  totalTools: number;
} {
  let readyCount = 0;
  let warmingCount = 0;
  let staleCount = 0;
  let totalTools = 0;

  namespaceToolCache.forEach((entry) => {
    switch (entry.status) {
      case "ready":
        readyCount++;
        totalTools += entry.tools.length;
        break;
      case "warming":
        warmingCount++;
        break;
      case "stale":
        staleCount++;
        break;
    }
  });

  return {
    totalNamespaces: namespaceToolCache.size,
    readyCount,
    warmingCount,
    staleCount,
    totalTools,
  };
}

/**
 * Clear entire cache. Use for testing or emergency reset.
 */
export function clearAllNamespaceCache(): void {
  namespaceToolCache.clear();
  warmingPromises.clear();
  logger.warn("ToolCache", "Cleared all namespace tool caches");
}

