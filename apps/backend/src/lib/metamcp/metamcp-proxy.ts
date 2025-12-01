import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  CallToolRequestSchema,
  CallToolResult,
  CompatibilityCallToolResultSchema,
  GetPromptRequestSchema,
  GetPromptResultSchema,
  ListPromptsRequestSchema,
  ListPromptsResultSchema,
  ListResourcesRequestSchema,
  ListResourcesResultSchema,
  ListResourceTemplatesRequestSchema,
  ListResourceTemplatesResultSchema,
  ListToolsRequestSchema,
  ListToolsResultSchema,
  ReadResourceRequestSchema,
  ReadResourceResultSchema,
  ResourceTemplate,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { configService } from "../config.service";
import { ConnectedClient } from "./client";
import { getMcpServers } from "./fetch-metamcp";
import { mcpServerPool } from "./mcp-server-pool";

// ============================================================================
// Pagination Configuration
// ============================================================================

/**
 * Default page size for list_tools pagination.
 * Can be overridden via MCP_TOOLS_PAGE_SIZE environment variable.
 */
const DEFAULT_TOOLS_PAGE_SIZE = 50;

/**
 * Get the configured page size for tools pagination.
 */
function getToolsPageSize(): number {
  const envPageSize = process.env.MCP_TOOLS_PAGE_SIZE;
  if (envPageSize) {
    const parsed = parseInt(envPageSize, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_TOOLS_PAGE_SIZE;
}

// Note: Tool caching is now handled at the namespace level via namespace-tool-cache.ts
// This enables cache sharing across all sessions in a namespace.
import {
  createFilterCallToolMiddleware,
  createFilterListToolsMiddleware,
} from "./metamcp-middleware/filter-tools.functional";
import {
  CallToolHandler,
  compose,
  ListToolsHandler,
  MetaMCPHandlerContext,
} from "./metamcp-middleware/functional-middleware";
import {
  createToolOverridesCallToolMiddleware,
  createToolOverridesListToolsMiddleware,
} from "./metamcp-middleware/tool-overrides.functional";
import { logger, paginationLog } from "./logger";
import {
  getNamespaceTools,
  warmNamespaceCache,
} from "./namespace-tool-cache";
import { parseToolName } from "./tool-name-parser";
import { fetchAllToolsFromUpstream } from "./tool-fetcher";
import { sanitizeName } from "./utils";

export const createServer = async (
  namespaceUuid: string,
  sessionId: string,
  includeInactiveServers: boolean = false,
) => {
  const toolToClient: Record<string, ConnectedClient> = {};
  const toolToServerUuid: Record<string, string> = {};
  const promptToClient: Record<string, ConnectedClient> = {};
  const resourceToClient: Record<string, ConnectedClient> = {};

  // Helper function to detect if a server is the same instance
  const isSameServerInstance = (
    params: { name?: string; url?: string | null },
    _serverUuid: string,
  ): boolean => {
    // Check if server name is exactly the same as our current server instance
    // This prevents exact recursive calls to the same server
    if (params.name === `metamcp-unified-${namespaceUuid}`) {
      return true;
    }

    return false;
  };

  const server = new Server(
    {
      name: `metamcp-unified-${namespaceUuid}`,
      version: "1.0.0",
    },
    {
      capabilities: {
        prompts: {},
        resources: {},
        tools: {},
      },
    },
  );

  // Create the handler context
  const handlerContext: MetaMCPHandlerContext = {
    namespaceUuid,
    sessionId,
  };

  // Original List Tools Handler with Pagination Support
  // Uses namespace-level cache for fast responses across all sessions
  const originalListToolsHandler: ListToolsHandler = async (
    request,
    context,
  ) => {
    const pageSize = getToolsPageSize();
    
    // Parse cursor as offset (default to 0 for first page)
    let offset = 0;
    if (request.params?.cursor) {
      const parsedOffset = parseInt(request.params.cursor, 10);
      if (!isNaN(parsedOffset) && parsedOffset >= 0) {
        offset = parsedOffset;
      }
    }

    // Check for forceRefresh param - invalidates cache to fetch fresh data from upstream
    if (request.params?.forceRefresh === true) {
      paginationLog.info(
        `Force refresh requested for namespace ${context.namespaceUuid.slice(0, 8)}`,
      );
      invalidateNamespaceCache(context.namespaceUuid);
    }

    let allTools: Tool[];

    // Step 1: Check namespace-level cache (shared across all sessions)
    paginationLog.debug(`Checking cache for namespace ${context.namespaceUuid.slice(0, 8)}`);
    const namespaceCached = getNamespaceTools(context.namespaceUuid);

    if (namespaceCached) {
      // Namespace cache hit - use cached tools directly
      // Skip building session mappings here - they will be built lazily
      // when tools are actually called (call_tool handler has fallback routing)
      paginationLog.debug(`Cache HIT: returning ${namespaceCached.length} tools`);
      allTools = namespaceCached;
    } else {
      // Namespace cache miss - warm cache using deduplication
      paginationLog.info(`Cache MISS: warming cache for namespace ${context.namespaceUuid.slice(0, 8)}...`);

      // warmNamespaceCache handles concurrent request deduplication
      // Note: We skip building mappings here - they will be built lazily when tools are called
      const fetchedTools = await warmNamespaceCache(
        context.namespaceUuid,
        async () => {
          const result = await fetchAllToolsFromUpstream(
            context.namespaceUuid,
            context.sessionId,
            includeInactiveServers,
          );
          // Note: We DON'T apply mappings here anymore - lazy loading instead
          return result.tools;
        },
      );

      allTools = fetchedTools;
      paginationLog.info(`Warming complete: ${allTools.length} tools`);
    }

    // Apply pagination: slice the tools array based on offset and page size
    const totalTools = allTools.length;
    const pageTools = allTools.slice(offset, offset + pageSize);
    
    // Calculate nextCursor: only set if there are more tools after this page
    const nextOffset = offset + pageSize;
    const nextCursor = nextOffset < totalTools ? String(nextOffset) : undefined;

    paginationLog.debug(
      `Page: offset=${offset} size=${pageTools.length}/${totalTools} next=${nextCursor ?? "end"}`,
    );

    return { 
      tools: pageTools,
      nextCursor: nextCursor,
    };
  };

  // Original Call Tool Handler
  const originalCallToolHandler: CallToolHandler = async (
    request,
    _context,
  ) => {
    const { name, arguments: args } = request.params;

    // Parse the tool name using shared utility
    const parsed = parseToolName(name);
    if (!parsed) {
      throw new Error(`Invalid tool name format: ${name}`);
    }

    const { serverName: serverPrefix, originalToolName } = parsed;

    // Try to find the tool in pre-populated mappings first
    let clientForTool = toolToClient[name];
    let serverUuid = toolToServerUuid[name];

    // If not found in mappings, dynamically find the server and route the call
    if (!clientForTool || !serverUuid) {
      try {
        // Get all MCP servers for this namespace
        const serverParams = await getMcpServers(
          namespaceUuid,
          includeInactiveServers,
        );

        // Find the server with the matching name prefix
        for (const [mcpServerUuid, params] of Object.entries(serverParams)) {
          const session = await mcpServerPool.getSession(
            sessionId,
            mcpServerUuid,
            params,
            namespaceUuid,
          );

          if (session) {
            const capabilities = session.client.getServerCapabilities();
            if (!capabilities?.tools) continue;

            // Use name assigned by user, fallback to name from server
            const serverName =
              params.name || session.client.getServerVersion()?.name || "";

            if (sanitizeName(serverName) === serverPrefix) {
              // Found the server, now check if it has this tool with pagination
              try {
                let foundTool = false;
                let cursor: string | undefined = undefined;
                let hasMore = true;

                while (hasMore && !foundTool) {
                  const result: z.infer<typeof ListToolsResultSchema> =
                    await session.client.request(
                      {
                        method: "tools/list",
                        params: { cursor: cursor },
                      },
                      ListToolsResultSchema,
                    );

                  if (
                    result.tools?.some(
                      (tool: Tool) => tool.name === originalToolName,
                    )
                  ) {
                    foundTool = true;
                    // Tool exists, populate mappings for future use and use it
                    clientForTool = session;
                    serverUuid = mcpServerUuid;
                    toolToClient[name] = session;
                    toolToServerUuid[name] = mcpServerUuid;
                    break;
                  }

                  cursor = result.nextCursor;
                  hasMore = !!result.nextCursor;
                }

                if (foundTool) {
                  break;
                }
              } catch (error) {
                console.error(
                  `Error checking tools for server ${serverName}:`,
                  error,
                );
                continue;
              }
            }
          }
        }
      } catch (error) {
        console.error(`Error dynamically finding tool ${name}:`, error);
      }
    }

    if (!clientForTool) {
      throw new Error(`Unknown tool: ${name}`);
    }

    if (!serverUuid) {
      throw new Error(`Server UUID not found for tool: ${name}`);
    }

    try {
      const abortController = new AbortController();

      // Get configurable timeout values
      const resetTimeoutOnProgress =
        await configService.getMcpResetTimeoutOnProgress();
      const timeout = await configService.getMcpTimeout();
      const maxTotalTimeout = await configService.getMcpMaxTotalTimeout();

      const mcpRequestOptions: RequestOptions = {
        signal: abortController.signal,
        resetTimeoutOnProgress,
        timeout,
        maxTotalTimeout,
      };
      // Use the correct schema for tool calls
      const result = await clientForTool.client.request(
        {
          method: "tools/call",
          params: {
            name: originalToolName,
            arguments: args || {},
            _meta: request.params._meta,
          },
        },
        CompatibilityCallToolResultSchema,
        mcpRequestOptions,
      );

      // Cast the result to CallToolResult type
      return result as CallToolResult;
    } catch (error) {
      console.error(
        `Error calling tool "${name}" through ${
          clientForTool.client.getServerVersion()?.name || "unknown"
        }:`,
        error,
      );
      throw error;
    }
  };

  // Compose middleware with handlers - this is the Express-like functional approach
  const listToolsWithMiddleware = compose(
    createToolOverridesListToolsMiddleware({
      cacheEnabled: true,
      persistentCacheOnListTools: true,
    }),
    createFilterListToolsMiddleware({ cacheEnabled: true }),
    // Add more middleware here as needed
    // createLoggingMiddleware(),
    // createRateLimitingMiddleware(),
  )(originalListToolsHandler);

  const callToolWithMiddleware = compose(
    createFilterCallToolMiddleware({
      cacheEnabled: true,
      customErrorMessage: (toolName, reason) =>
        `Access denied to tool "${toolName}": ${reason}`,
    }),
    createToolOverridesCallToolMiddleware({ cacheEnabled: true }),
    // Add more middleware here as needed
    // createAuditingMiddleware(),
    // createAuthorizationMiddleware(),
  )(originalCallToolHandler);

  // Set up the handlers with middleware
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    return await listToolsWithMiddleware(request, handlerContext);
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return await callToolWithMiddleware(request, handlerContext);
  });

  // Get Prompt Handler
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name } = request.params;
    const clientForPrompt = promptToClient[name];

    if (!clientForPrompt) {
      throw new Error(`Unknown prompt: ${name}`);
    }

    try {
      // Parse the prompt name using shared utility
      const parsed = parseToolName(name);
      if (!parsed) {
        throw new Error(`Invalid prompt name format: ${name}`);
      }

      const promptName = parsed.originalToolName;
      const response = await clientForPrompt.client.request(
        {
          method: "prompts/get",
          params: {
            name: promptName,
            arguments: request.params.arguments || {},
            _meta: request.params._meta,
          },
        },
        GetPromptResultSchema,
      );

      return response;
    } catch (error) {
      console.error(
        `Error getting prompt through ${
          clientForPrompt.client.getServerVersion()?.name
        }:`,
        error,
      );
      throw error;
    }
  });

  // List Prompts Handler
  server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
    const serverParams = await getMcpServers(
      namespaceUuid,
      includeInactiveServers,
    );
    const allPrompts: z.infer<typeof ListPromptsResultSchema>["prompts"] = [];

    // Track visited servers to detect circular references - reset on each call
    const visitedServers = new Set<string>();

    // Filter out self-referencing servers before processing
    const validPromptServers = Object.entries(serverParams).filter(
      ([uuid, params]) => {
        // Skip if we've already visited this server to prevent circular references
        if (visitedServers.has(uuid)) {
          return false;
        }

        // Check if this server is the same instance to prevent self-referencing
        if (isSameServerInstance(params, uuid)) {
          return false;
        }

        // Mark this server as visited
        visitedServers.add(uuid);
        return true;
      },
    );

    await Promise.allSettled(
      validPromptServers.map(async ([uuid, params]) => {
        const session = await mcpServerPool.getSession(
          sessionId,
          uuid,
          params,
          namespaceUuid,
        );
        if (!session) return;

        // Now check for self-referencing using the actual MCP server name
        const serverVersion = session.client.getServerVersion();
        const actualServerName = serverVersion?.name || params.name || "";
        const ourServerName = `metamcp-unified-${namespaceUuid}`;

        if (actualServerName === ourServerName) {
          return;
        }

        const capabilities = session.client.getServerCapabilities();
        if (!capabilities?.prompts) return;

        // Use name assigned by user, fallback to name from server
        const serverName =
          params.name || session.client.getServerVersion()?.name || "";
        try {
          const result = await session.client.request(
            {
              method: "prompts/list",
              params: {
                cursor: request.params?.cursor,
                _meta: request.params?._meta,
              },
            },
            ListPromptsResultSchema,
          );

          if (result.prompts) {
            const promptsWithSource = result.prompts.map((prompt) => {
              const promptName = `${sanitizeName(serverName)}__${prompt.name}`;
              promptToClient[promptName] = session;
              return {
                ...prompt,
                name: promptName,
                description: prompt.description || "",
              };
            });
            allPrompts.push(...promptsWithSource);
          }
        } catch (error) {
          console.error(`Error fetching prompts from: ${serverName}`, error);
        }
      }),
    );

    return {
      prompts: allPrompts,
      nextCursor: request.params?.cursor,
    };
  });

  // List Resources Handler
  server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
    const serverParams = await getMcpServers(
      namespaceUuid,
      includeInactiveServers,
    );
    const allResources: z.infer<typeof ListResourcesResultSchema>["resources"] =
      [];

    // Track visited servers to detect circular references - reset on each call
    const visitedServers = new Set<string>();

    // Filter out self-referencing servers before processing
    const validResourceServers = Object.entries(serverParams).filter(
      ([uuid, params]) => {
        // Skip if we've already visited this server to prevent circular references
        if (visitedServers.has(uuid)) {
          return false;
        }

        // Check if this server is the same instance to prevent self-referencing
        if (isSameServerInstance(params, uuid)) {
          return false;
        }

        // Mark this server as visited
        visitedServers.add(uuid);
        return true;
      },
    );

    await Promise.allSettled(
      validResourceServers.map(async ([uuid, params]) => {
        const session = await mcpServerPool.getSession(
          sessionId,
          uuid,
          params,
          namespaceUuid,
        );
        if (!session) return;

        // Now check for self-referencing using the actual MCP server name
        const serverVersion = session.client.getServerVersion();
        const actualServerName = serverVersion?.name || params.name || "";
        const ourServerName = `metamcp-unified-${namespaceUuid}`;

        if (actualServerName === ourServerName) {
          return;
        }

        const capabilities = session.client.getServerCapabilities();
        if (!capabilities?.resources) return;

        // Use name assigned by user, fallback to name from server
        const serverName =
          params.name || session.client.getServerVersion()?.name || "";
        try {
          const result = await session.client.request(
            {
              method: "resources/list",
              params: {
                cursor: request.params?.cursor,
                _meta: request.params?._meta,
              },
            },
            ListResourcesResultSchema,
          );

          if (result.resources) {
            const resourcesWithSource = result.resources.map((resource) => {
              resourceToClient[resource.uri] = session;
              return {
                ...resource,
                name: resource.name || "",
              };
            });
            allResources.push(...resourcesWithSource);
          }
        } catch (error) {
          console.error(`Error fetching resources from: ${serverName}`, error);
        }
      }),
    );

    return {
      resources: allResources,
      nextCursor: request.params?.cursor,
    };
  });

  // Read Resource Handler
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    const clientForResource = resourceToClient[uri];

    if (!clientForResource) {
      throw new Error(`Unknown resource: ${uri}`);
    }

    try {
      return await clientForResource.client.request(
        {
          method: "resources/read",
          params: {
            uri,
            _meta: request.params._meta,
          },
        },
        ReadResourceResultSchema,
      );
    } catch (error) {
      console.error(
        `Error reading resource through ${
          clientForResource.client.getServerVersion()?.name
        }:`,
        error,
      );
      throw error;
    }
  });

  // List Resource Templates Handler
  server.setRequestHandler(
    ListResourceTemplatesRequestSchema,
    async (request) => {
      const serverParams = await getMcpServers(
        namespaceUuid,
        includeInactiveServers,
      );
      const allTemplates: ResourceTemplate[] = [];

      // Track visited servers to detect circular references - reset on each call
      const visitedServers = new Set<string>();

      // Filter out self-referencing servers before processing
      const validTemplateServers = Object.entries(serverParams).filter(
        ([uuid, params]) => {
          // Skip if we've already visited this server to prevent circular references
          if (visitedServers.has(uuid)) {
            return false;
          }

          // Check if this server is the same instance to prevent self-referencing
          if (isSameServerInstance(params, uuid)) {
            return false;
          }

          // Mark this server as visited
          visitedServers.add(uuid);
          return true;
        },
      );

      await Promise.allSettled(
        validTemplateServers.map(async ([uuid, params]) => {
          const session = await mcpServerPool.getSession(
            sessionId,
            uuid,
            params,
            namespaceUuid,
          );
          if (!session) return;

          // Now check for self-referencing using the actual MCP server name
          const serverVersion = session.client.getServerVersion();
          const actualServerName = serverVersion?.name || params.name || "";
          const ourServerName = `metamcp-unified-${namespaceUuid}`;

          if (actualServerName === ourServerName) {
            return;
          }

          const capabilities = session.client.getServerCapabilities();
          if (!capabilities?.resources) return;

          const serverName =
            params.name || session.client.getServerVersion()?.name || "";

          try {
            const result = await session.client.request(
              {
                method: "resources/templates/list",
                params: {
                  cursor: request.params?.cursor,
                  _meta: request.params?._meta,
                },
              },
              ListResourceTemplatesResultSchema,
            );

            if (result.resourceTemplates) {
              const templatesWithSource = result.resourceTemplates.map(
                (template) => ({
                  ...template,
                  name: template.name || "",
                }),
              );
              allTemplates.push(...templatesWithSource);
            }
          } catch (error) {
            console.error(
              `Error fetching resource templates from: ${serverName}`,
              error,
            );
            return;
          }
        }),
      );

      return {
        resourceTemplates: allTemplates,
        nextCursor: request.params?.cursor,
      };
    },
  );

  const cleanup = async () => {
    // Note: Namespace-level tool cache persists across sessions
    // It's only invalidated when MCP server config changes
    await mcpServerPool.cleanupSession(sessionId);
  };

  return { server, cleanup };
};
