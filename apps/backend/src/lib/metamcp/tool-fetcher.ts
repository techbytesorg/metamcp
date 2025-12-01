import {
  ListToolsResultSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { toolsImplementations } from "../../trpc/tools.impl";
import { ConnectedClient } from "./client";
import { getMcpServers } from "./fetch-metamcp";
import { logger } from "./logger";
import { mcpServerPool } from "./mcp-server-pool";
import { mapOverrideNameToOriginal } from "./metamcp-middleware/tool-overrides.functional";
import { sanitizeName } from "./utils";

// ============================================================================
// Session Error Detection
// ============================================================================

/**
 * Check if an error is a stale/expired session error from upstream MCP server.
 * These errors indicate we need to reconnect with a fresh session.
 * Exported for testing.
 */
export function isSessionExpiredError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    // Common session expiry error patterns
    return (
      message.includes("session_not_found") ||
      message.includes("invalid session") ||
      message.includes("session expired") ||
      message.includes("session timeout")
    );
  }
  return false;
}

// ============================================================================
// Tool Fetcher Utility
// ============================================================================
// Extracted tool fetching logic for reuse in:
// 1. list_tools handler (on-demand fetching)
// 2. Cache pre-warming (background fetching)
// ============================================================================

/**
 * Mappings from tool names to their upstream connections.
 * Required for routing tool calls to the correct upstream server.
 */
export interface ToolMappings {
  toolToClient: Record<string, ConnectedClient>;
  toolToServerUuid: Record<string, string>;
}

/**
 * Result of fetching all tools from upstream servers.
 */
export interface FetchToolsResult {
  tools: Tool[];
  mappings: ToolMappings;
}

/**
 * Filter out tools that are overrides of existing tools to prevent duplicates in database.
 * Uses the existing tool overrides cache for optimal performance.
 */
async function filterOutOverrideTools(
  tools: Tool[],
  namespaceUuid: string,
  serverName: string,
): Promise<Tool[]> {
  if (!tools || tools.length === 0) {
    return tools;
  }

  const filteredTools: Tool[] = [];

  await Promise.allSettled(
    tools.map(async (tool) => {
      try {
        // Check if this tool name is actually an override name for an existing tool
        const fullToolName = `${sanitizeName(serverName)}__${tool.name}`;
        const originalName = await mapOverrideNameToOriginal(
          fullToolName,
          namespaceUuid,
          true, // use cache
        );

        // If the original name is different from the current name,
        // this tool is an override and should be filtered out
        if (originalName !== fullToolName) {
          return;
        }

        // This is not an override, include it
        filteredTools.push(tool);
      } catch (error) {
        logger.error("ToolFetcher", `Error checking if tool ${tool.name} is an override`, error);
        // On error, include the tool (fail-safe behavior)
        filteredTools.push(tool);
      }
    }),
  );

  return filteredTools;
}

/**
 * Check if a server is the same instance as the MetaMCP server itself.
 * Prevents self-referencing / infinite loops.
 */
function isSameServerInstance(
  params: { name?: string; url?: string | null },
  namespaceUuid: string,
): boolean {
  if (params.name === `metamcp-unified-${namespaceUuid}`) {
    return true;
  }
  return false;
}

/**
 * Fetch all tools from all upstream MCP servers for a namespace.
 * 
 * @param namespaceUuid - The namespace to fetch tools for
 * @param sessionId - Session ID for MCP connections
 * @param includeInactiveServers - Whether to include inactive servers
 * @returns Promise resolving to tools and mappings
 */
export async function fetchAllToolsFromUpstream(
  namespaceUuid: string,
  sessionId: string,
  includeInactiveServers: boolean = false,
): Promise<FetchToolsResult> {
  const startTime = Date.now();
  
  const toolToClient: Record<string, ConnectedClient> = {};
  const toolToServerUuid: Record<string, string> = {};
  const allTools: Tool[] = [];

  const serverParams = await getMcpServers(namespaceUuid, includeInactiveServers);
  
  // Track visited servers to detect circular references
  const visitedServers = new Set<string>();
  const allServerEntries = Object.entries(serverParams);

  logger.debug("ToolFetcher", `Fetching tools from ${allServerEntries.length} servers for namespace ${namespaceUuid.slice(0, 8)}...`);

  await Promise.allSettled(
    allServerEntries.map(async ([mcpServerUuid, params]) => {
      // Skip if we've already visited this server to prevent circular references
      if (visitedServers.has(mcpServerUuid)) {
        return;
      }

      const session = await mcpServerPool.getSession(
        sessionId,
        mcpServerUuid,
        params,
        namespaceUuid,
      );
      if (!session) return;

      // Check for self-referencing using the actual MCP server name
      const serverVersion = session.client.getServerVersion();
      const actualServerName = serverVersion?.name || params.name || "";
      const ourServerName = `metamcp-unified-${namespaceUuid}`;

      if (actualServerName === ourServerName) {
        logger.debug("ToolFetcher", `Skipping self-reference: ${actualServerName}`);
        return;
      }

      // Check basic self-reference patterns
      if (isSameServerInstance(params, mcpServerUuid)) {
        return;
      }

      // Mark this server as visited
      visitedServers.add(mcpServerUuid);

      const capabilities = session.client.getServerCapabilities();
      if (!capabilities?.tools) return;

      // Use name assigned by user, fallback to name from server
      const serverName = params.name || session.client.getServerVersion()?.name || "";

      // Helper function to fetch tools with retry on session expiry
      const fetchToolsWithRetry = async (
        currentSession: ConnectedClient,
        isRetry: boolean = false,
      ): Promise<{ tools: Tool[]; session: ConnectedClient }> => {
        try {
          // Paginated tool discovery from upstream - load all pages automatically
          const allServerTools: Tool[] = [];
          let upstreamCursor: string | undefined = undefined;
          let hasMore = true;

          while (hasMore) {
            const result: z.infer<typeof ListToolsResultSchema> =
              await currentSession.client.request(
                {
                  method: "tools/list",
                  params: {
                    cursor: upstreamCursor,
                  },
                },
                ListToolsResultSchema,
              );

            if (result.tools && result.tools.length > 0) {
              allServerTools.push(...result.tools);
            }

            upstreamCursor = result.nextCursor;
            hasMore = !!result.nextCursor;
          }

          return { tools: allServerTools, session: currentSession };
        } catch (error) {
          // Check if this is a stale session error and we haven't retried yet
          if (isSessionExpiredError(error) && !isRetry) {
            logger.warn(
              "ToolFetcher",
              `Session expired for ${serverName}, reconnecting...`,
            );

            // Invalidate the stale active session first (removes from cache)
            await mcpServerPool.invalidateActiveSession(sessionId, mcpServerUuid);

            // Also invalidate the idle session to ensure fresh connection
            await mcpServerPool.invalidateIdleSession(
              mcpServerUuid,
              params,
              namespaceUuid,
            );

            // Get a fresh session
            const newSession = await mcpServerPool.getSession(
              sessionId,
              mcpServerUuid,
              params,
              namespaceUuid,
            );

            if (!newSession) {
              throw new Error(
                `Failed to reconnect to ${serverName} after session expiry`,
              );
            }

            logger.info(
              "ToolFetcher",
              `Reconnected to ${serverName}, retrying tool fetch...`,
            );

            // Retry with the fresh session
            return fetchToolsWithRetry(newSession, true);
          }

          // Not a session error or already retried, rethrow
          throw error;
        }
      };

      try {
        // Fetch tools with automatic retry on session expiry
        const { tools: allServerTools, session: activeSession } =
          await fetchToolsWithRetry(session);

        // Save original tools to database (before middleware processing)
        if (allServerTools.length > 0) {
          try {
            const toolsToSave = await filterOutOverrideTools(
              allServerTools,
              namespaceUuid,
              serverName,
            );

            if (toolsToSave.length > 0) {
              await toolsImplementations.create({
                tools: toolsToSave,
                mcpServerUuid: mcpServerUuid,
              });
            }
          } catch (dbError) {
            logger.error("ToolFetcher", `Error saving tools to database for server ${serverName}`, dbError);
          }
        }

        // Build tool list with namespaced names and mappings
        // Use activeSession (might be a fresh one if we reconnected)
        const toolsWithSource = allServerTools.map((tool) => {
          const toolName = `${sanitizeName(serverName)}__${tool.name}`;
          toolToClient[toolName] = activeSession;
          toolToServerUuid[toolName] = mcpServerUuid;

          return {
            ...tool,
            name: toolName,
            description: tool.description,
          };
        });

        allTools.push(...toolsWithSource);
        logger.debug("ToolFetcher", `Fetched ${allServerTools.length} tools from ${serverName}`);
      } catch (error) {
        logger.error("ToolFetcher", `Error fetching tools from: ${serverName}`, error);
      }
    }),
  );

  const duration = Date.now() - startTime;
  logger.info("ToolFetcher", `Fetched ${allTools.length} total tools in ${duration}ms`);

  return {
    tools: allTools,
    mappings: {
      toolToClient,
      toolToServerUuid,
    },
  };
}

/**
 * Build session-level tool mappings from cached tools.
 * Used when tools are retrieved from namespace cache but need
 * session-specific client mappings for tool call routing.
 * 
 * @param tools - Cached tools with namespaced names
 * @param namespaceUuid - The namespace UUID
 * @param sessionId - Session ID for MCP connections
 * @param includeInactiveServers - Whether to include inactive servers
 * @returns Promise resolving to tool mappings
 */
export async function buildToolMappingsFromCache(
  tools: Tool[],
  namespaceUuid: string,
  sessionId: string,
  includeInactiveServers: boolean = false,
): Promise<ToolMappings> {
  const toolToClient: Record<string, ConnectedClient> = {};
  const toolToServerUuid: Record<string, string> = {};

  // Get server params to build mappings
  const serverParams = await getMcpServers(namespaceUuid, includeInactiveServers);

  // Group tools by server prefix
  const toolsByServer: Map<string, Tool[]> = new Map();
  for (const tool of tools) {
    const [serverPrefix] = tool.name.split("__");
    if (!toolsByServer.has(serverPrefix)) {
      toolsByServer.set(serverPrefix, []);
    }
    toolsByServer.get(serverPrefix)!.push(tool);
  }

  // Build mappings for each server
  await Promise.allSettled(
    Object.entries(serverParams).map(async ([mcpServerUuid, params]) => {
      const serverName = params.name || "";
      const sanitizedName = sanitizeName(serverName);
      const serverTools = toolsByServer.get(sanitizedName);

      if (!serverTools || serverTools.length === 0) {
        return;
      }

      const session = await mcpServerPool.getSession(
        sessionId,
        mcpServerUuid,
        params,
        namespaceUuid,
      );

      if (!session) return;

      // Map all tools from this server to this session
      for (const tool of serverTools) {
        toolToClient[tool.name] = session;
        toolToServerUuid[tool.name] = mcpServerUuid;
      }
    }),
  );

  return {
    toolToClient,
    toolToServerUuid,
  };
}

