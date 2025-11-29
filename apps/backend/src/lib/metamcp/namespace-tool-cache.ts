import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { logger } from "./logger";

// ============================================================================
// Namespace-Level Tool Cache with Background Refresh
// ============================================================================
// This cache stores aggregated tools at the namespace level, enabling:
// 1. Cache sharing across all sessions in a namespace
// 2. Pre-warming when idle servers are created
// 3. Fast list_tools() responses (~50ms vs 38-39s)
// 4. Background refresh to keep cache always warm
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
 * Store fetch functions for background refresh.
 * Key: namespaceUuid
 * Value: Fetch function that returns tools
 */
const refreshFunctions: Map<string, () => Promise<Tool[]>> = new Map();

/**
 * Background refresh timer
 */
let backgroundRefreshTimer: NodeJS.Timeout | null = null;

/**
 * Default TTL for cached tools (1 hour in milliseconds).
 * Can be overridden via MCP_TOOLS_CACHE_TTL env var (in seconds).
 */
const DEFAULT_CACHE_TTL_MS = 3600 * 1000; // 1 hour

/**
 * Refresh threshold - refresh when cache age exceeds this % of TTL.
 * Default: 80% (refresh 12 min before 1-hour expiry)
 */
const REFRESH_THRESHOLD = 0.8;

/**
 * Background refresh interval (check every 5 minutes)
 */
const BACKGROUND_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

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
  refreshFunctions.delete(namespaceUuid);
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

  // Store the fetch function for background refresh
  refreshFunctions.set(namespaceUuid, fetchFn);

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
  
  // Start background refresh if not already running
  startBackgroundRefresh();
  
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
  refreshFunctions.clear();
  stopBackgroundRefresh();
  logger.warn("ToolCache", "Cleared all namespace tool caches");
}

// ============================================================================
// Background Refresh
// ============================================================================
// Proactively refresh cache entries before they expire to ensure
// clients always get fast responses.
// ============================================================================

/**
 * Check if a cache entry needs proactive refresh.
 * Returns true if entry is past the refresh threshold (default 80% of TTL).
 */
function needsProactiveRefresh(entry: NamespaceToolCacheEntry): boolean {
  const ttl = getCacheTTL();
  // TTL=0 means never expires - no proactive refresh needed
  if (ttl === 0) {
    return false;
  }
  const age = Date.now() - entry.timestamp;
  const threshold = ttl * REFRESH_THRESHOLD;
  return age > threshold && entry.status === "ready";
}

/**
 * Perform background refresh for all cache entries that need it.
 * This runs periodically to keep caches warm.
 */
async function performBackgroundRefresh(): Promise<void> {
  const ttl = getCacheTTL();
  if (ttl === 0) {
    // TTL disabled, no background refresh needed
    return;
  }

  const namespacesToRefresh: string[] = [];
  
  // Find entries that need refresh
  namespaceToolCache.forEach((entry, namespaceUuid) => {
    if (needsProactiveRefresh(entry)) {
      namespacesToRefresh.push(namespaceUuid);
    }
  });

  if (namespacesToRefresh.length === 0) {
    return;
  }

  console.log(`[ToolCache] Background refresh: ${namespacesToRefresh.length} namespace(s) need refresh`);

  // Refresh each namespace
  for (const namespaceUuid of namespacesToRefresh) {
    const fetchFn = refreshFunctions.get(namespaceUuid);
    if (!fetchFn) {
      console.log(`[ToolCache] Background refresh: No fetch function for ${namespaceUuid.slice(0, 8)}..., skipping`);
      continue;
    }

    // Check if already warming (don't double-refresh)
    if (warmingPromises.has(namespaceUuid)) {
      console.log(`[ToolCache] Background refresh: ${namespaceUuid.slice(0, 8)}... already warming, skipping`);
      continue;
    }

    try {
      console.log(`[ToolCache] Background refresh: Refreshing ${namespaceUuid.slice(0, 8)}...`);
      const startTime = Date.now();
      
      // Directly fetch and update (don't go through warmNamespaceCache to avoid recursion)
      const tools = await fetchFn();
      setNamespaceTools(namespaceUuid, tools);
      
      const duration = Date.now() - startTime;
      console.log(`[ToolCache] Background refresh: ${namespaceUuid.slice(0, 8)}... done (${tools.length} tools in ${duration}ms)`);
    } catch (error) {
      // Don't invalidate on background refresh failure - keep serving stale data
      console.error(`[ToolCache] Background refresh failed for ${namespaceUuid.slice(0, 8)}...`, error);
    }
  }
}

/**
 * Start the background refresh timer.
 * Safe to call multiple times - will not create duplicate timers.
 */
export function startBackgroundRefresh(): void {
  if (backgroundRefreshTimer) {
    return; // Already running
  }

  const ttl = getCacheTTL();
  if (ttl === 0) {
    console.log("[ToolCache] Background refresh disabled (TTL=0)");
    return;
  }

  console.log(`[ToolCache] Starting background refresh (interval: ${BACKGROUND_REFRESH_INTERVAL_MS / 1000}s, TTL: ${ttl / 1000}s)`);
  
  backgroundRefreshTimer = setInterval(async () => {
    try {
      await performBackgroundRefresh();
    } catch (error) {
      console.error("[ToolCache] Background refresh error:", error);
    }
  }, BACKGROUND_REFRESH_INTERVAL_MS);

  // Don't prevent Node.js from exiting
  backgroundRefreshTimer.unref();
}

/**
 * Stop the background refresh timer.
 */
export function stopBackgroundRefresh(): void {
  if (backgroundRefreshTimer) {
    clearInterval(backgroundRefreshTimer);
    backgroundRefreshTimer = null;
    console.log("[ToolCache] Stopped background refresh");
  }
}

/**
 * Check if background refresh is running.
 */
export function isBackgroundRefreshRunning(): boolean {
  return backgroundRefreshTimer !== null;
}

