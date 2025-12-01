# Session Persistence Issue Analysis

## Problem Description

After login, users can fetch tools from MetaMCP successfully. However, when the page is refreshed, no tools are available. The MetaMCP console shows intermittent connection issues.

## Root Cause Analysis

Based on AWS CloudWatch logs analysis, the issue is a **session ID mismatch** between frontend and backend:

### What's Happening

1. **Frontend Behavior**: On page refresh, the `StreamableHTTPClientTransport` creates a new session ID every time
   - Line 547 in `useConnection.ts`: `sessionId: undefined` forces new session creation
   - No session persistence across page refreshes

2. **Backend Behavior**: Server maintains all previous session IDs in memory
   - Sessions accumulate: 17+ active sessions shown in logs
   - Old sessions never get cleaned up properly

3. **The Mismatch**: Frontend requests with new session IDs that don't exist on server
   - Log pattern: "Transport not found for sessionId X. Available sessions: [Y, Z, ...]"
   - Server responds with 404 "Session not found"

### Evidence from Logs

```
Session ID: 43744c35-625a-4f07-ab46-b208887ad679
Available session IDs: [
  'b09f6fe5-612e-4710-b2be-2e68e97720ca',
  'bb2b6b77-4641-46ac-8a6c-d4fe70420f83',
  ...17 other sessions...
]
Transport not found for sessionId 43744c35-625a-4f07-ab46-b208887ad679
```

### Technical Details

- **Authentication**: OAuth works correctly (tokens are valid)
- **Session Creation**: New sessions are created successfully
- **Session Persistence**: Frontend doesn't store/reuse session IDs
- **Cleanup**: Old sessions accumulate on server without proper cleanup

## Immediate Solutions (for deployed instance)

### Option 1: Restart ECS Container (Recommended)
- **Effect**: Clears all stored sessions on server
- **Risk**: Low - will interrupt active connections briefly
- **Recovery**: Users need to refresh page once after restart

### Option 2: Clear Sessions via API
- Could implement a cleanup endpoint to clear stored sessions
- More complex, requires code deployment

## Long-term Fix

Implement session persistence in frontend:

1. Store session IDs in `sessionStorage`
2. Reuse existing sessions on page refresh
3. Proper cleanup when tab closes
4. Key changes needed in `useConnection.ts` around line 547

## Impact Assessment

- **Severity**: High - breaks core functionality after page refresh
- **Scope**: All users on deployed AWS instance
- **Workaround**: Users can still create new sessions by refreshing
- **Fix Complexity**: Medium - requires frontend session management

## Recommended Action

**Restart the ECS Fargate container** to immediately resolve the issue, then implement proper session persistence in the next deployment.