# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MetaMCP is a MCP (Model Context Protocol) proxy that aggregates multiple MCP servers into a unified interface. It serves as middleware/orchestrator/gateway that allows dynamic composition of MCP servers with authentication, namespaces, and pluggable middleware.

**Key Architecture**: Monorepo with Next.js frontend, Express.js backend, tRPC for API communication, PostgreSQL database, and Docker deployment.

## Development Commands

### Essential Commands
```bash
# Development (local with hot reload)
pnpm dev

# Development with Docker (includes PostgreSQL)  
pnpm run dev:docker
pnpm run dev:docker:down      # Stop development environment
pnpm run dev:docker:clean     # Clean up with volume removal

# Build and production
pnpm run build
pnpm run lint
pnpm run lint:fix
pnpm run format
pnpm run check-types
```

### Database Operations (Backend)
```bash
# Database migrations (use .env.local for development)
cd apps/backend
pnpm run db:generate:dev      # Generate migrations for dev
pnpm run db:migrate:dev       # Apply migrations for dev
pnpm run db:generate          # Generate for production
pnpm run db:migrate           # Apply for production
```

### Individual App Development
```bash
# Backend only
cd apps/backend && pnpm dev

# Frontend only  
cd apps/frontend && pnpm dev
```

## Architecture Overview

### Monorepo Structure
- `apps/backend/` - Express.js server with tRPC, MCP proxy logic, auth
- `apps/frontend/` - Next.js web interface for managing MCP servers/namespaces
- `packages/trpc/` - Shared tRPC router definitions
- `packages/zod-types/` - Shared validation schemas
- `packages/eslint-config/` - ESLint configurations
- `packages/typescript-config/` - TypeScript configurations

### Core Backend Components
- **MCP Proxy System** (`apps/backend/src/lib/metamcp/`) - Core MCP server aggregation and proxy logic
- **Server Pool Management** - Idle session management for MCP servers to reduce cold start
- **Authentication** - Better Auth integration with session cookies + API key auth
- **Database Layer** - Drizzle ORM with PostgreSQL for storing server configs, namespaces, endpoints
- **Transport Protocols** - SSE, Streamable HTTP, and OpenAPI endpoint generation

### Key Concepts
- **MCP Servers** - Individual MCP server configurations (STDIO/HTTP)
- **Namespaces** - Groups of MCP servers with middleware applied
- **Endpoints** - Public API endpoints that expose namespace functionality
- **Middleware** - Request/response interceptors (e.g., tool filtering)

## Environment Setup

### Required Environment Variables
Copy `example.env` to `.env` and configure:

**Core Settings:**
- `DATABASE_URL` - PostgreSQL connection string
- `BETTER_AUTH_SECRET` - Auth secret key
- `APP_URL` - Application URL (enforced by CORS)
- `NEXT_PUBLIC_APP_URL` - Frontend app URL

**Optional OIDC:**
- `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_DISCOVERY_URL` - For SSO integration

**Development Notes:**
- Environment variables in `turbo.json` under `globalEnv` are passed to development processes
- Use `.env.local` for local development, `.env` for production

## Testing and Quality

### Code Quality Commands
```bash
pnpm run lint          # Check all apps
pnpm run lint:fix      # Auto-fix linting issues
pnpm run check-types   # TypeScript type checking
pnpm run format        # Format code with Prettier
```

### Development Ports
- Frontend: 12008
- Backend: 12009  
- PostgreSQL (Docker): 9433

## Database Schema and Migrations

- Database schema in `apps/backend/src/db/schema.ts`
- Migrations in `apps/backend/drizzle/`
- Use Drizzle Kit for schema changes and migrations
- Repositories pattern in `apps/backend/src/db/repositories/`

## MCP Integration Patterns

### MCP Server Configuration
MCP servers support environment variable injection:
- Raw values: `API_KEY=actual-key`
- Environment references: `API_KEY=${OPENAI_API_KEY}`
- Auto-matching: Variables automatically passed if names match

### Idle Session Management
MetaMCP pre-allocates idle sessions for MCP servers to reduce cold start latency. Sessions invalidate on configuration updates.

## Authentication Flows

- **Frontend/Backend**: Better Auth with session cookies
- **API Access**: Bearer token authentication (`Authorization: Bearer sk_mt_...`)
- **MCP OAuth**: Standard OAuth in MCP Spec 2025-06-18 for endpoints
- **Multi-tenancy**: Support for private/public scopes and organizations

## Key Implementation Notes

- **Middleware System**: Pluggable request/response transformation at namespace level
- **Transport Support**: SSE, Streamable HTTP, OpenAPI for different client needs
- **Cold Start Optimization**: Pre-warmed idle sessions, custom Dockerfile support
- **CORS Enforcement**: Strict URL-based access control via APP_URL
- **Turborepo**: Uses Turbo for efficient monorepo builds and caching