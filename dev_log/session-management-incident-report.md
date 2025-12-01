# Session Management Incident Report
*Combined analysis of AWS Documentation server crash and session persistence issues*

## Executive Summary

Two separate issues occurred simultaneously on the deployed MetaMCP instance:
1. **AWS Documentation Server Crash** (isolated, minor impact)
2. **Session Management Bug** (system-wide, critical impact)

The AWS server crash likely triggered user troubleshooting activities that exposed the pre-existing session persistence bug, causing system-wide connection failures.

**Resolution**: ECS container restart completed. Monitoring in progress.

---

## Issue #1: AWS Documentation Server Crash

### Timeline
- **13:03 UTC**: Initial crash during server addition
- **13:08 UTC**: Automatic retry, same error
- **Status**: Server permanently marked as ERROR

### Root Cause
Python logging configuration error in AWS Documentation MCP server:
```
ValueError: Level '"error"' does not exist
ValueError: Level '"ERROR"' does not exist
```

### Technical Details
- Invalid `FASTMCP_LOG_LEVEL` environment variable
- Server unable to start due to loguru library configuration issue
- Impact: Only affects this one server, isolated failure

### Fix Required
- Check `FASTMCP_LOG_LEVEL` environment variable configuration
- Ensure valid log level (WARNING, INFO, DEBUG, ERROR - without quotes)
- Or remove environment variable to use default

---

## Issue #2: Session Management Bug (Critical)

### Timeline
- **13:03 UTC**: AWS server crash
- **13:14 UTC**: First session mismatch error (11 minutes later)
- **13:14-14:00 UTC**: Escalating session errors
- **System degradation**: 17+ orphaned sessions accumulated

### Root Cause Analysis

**Frontend Behavior** (apps/frontend/hooks/useConnection.ts:547):
- `sessionId: undefined` forces new session creation on every connection
- No session persistence across page refreshes
- Each refresh creates orphaned sessions

**Backend Behavior** (apps/backend/src/routers/public-metamcp/streamable-http.ts):
- Server maintains all previous session IDs in memory
- Sessions accumulate without proper cleanup
- Transport lookups fail for new session IDs

**The Mismatch**:
```
Session ID: 43744c35-625a-4f07-ab46-b208887ad679
Available sessions: ['b09f6fe5-612e-4710-b2be-2e68e97720ca', ...]
Transport not found for sessionId 43744c35-625a-4f07-ab46-b208887ad679
```

### Evidence from Logs
- 27+ session mismatch errors logged
- Pattern: Frontend requests with new IDs, backend has different stored IDs
- Error frequency: Occasional → Frequent → Constant
- Impact: All MCP connections fail after page refresh

### Why Both Issues Appeared Together
The AWS server crash triggered:
1. User attempts to check other servers
2. Page refreshes to troubleshoot
3. This exposed the existing session persistence bug

---

## Actions Taken

### Immediate Resolution
✅ **ECS Fargate container restarted**
- Clears all accumulated sessions from memory
- Restores normal operation for existing servers
- Users need to refresh once after restart

### Monitoring Status
🔄 **Currently monitoring** for:
- Session accumulation patterns
- Connection stability
- New session mismatch errors

---

## Prevention Guidelines (Until Session Persistence Fix)

### ❌ **HIGH RISK - Avoid These Actions:**

1. **Page Refreshes**
   - Don't refresh browser tabs with MetaMCP UI open
   - Don't refresh OAP frontend
   - Each refresh creates orphaned sessions

2. **Multiple Browser Tabs**
   - Don't open MetaMCP in multiple browser tabs
   - Don't open OAP in multiple tabs
   - Each tab creates separate sessions

3. **Browser Navigation**
   - Avoid using browser back/forward buttons in MetaMCP
   - Don't navigate away and back to MetaMCP pages
   - Avoid closing and reopening browser tabs

### ⚠️ **MEDIUM RISK - Use Sparingly:**

4. **MCP Server Testing**
   - Minimize connection testing in MetaMCP inspector
   - If testing required, do it in one session without refreshing

5. **Server Configuration**
   - Avoid adding new MCP servers until fix deployed
   - Postpone server configuration changes

### ✅ **SAFE Actions:**
- **Within same session**: Using existing connections, making requests, viewing tools
- **Log viewing**: Reading logs without refreshing
- **Server management**: View server status (don't test connections)
- **Configuration**: View settings (don't modify servers)

### 🔄 **If You Must Refresh:**
- **Wait 5-10 minutes** between refreshes
- **Use only ONE browser tab** at a time
- **Monitor** `/health/sessions` endpoint for session count
- **Consider ECS restart** if sessions > 20-30

---

## Long-term Fixes Required

### 1. Session Persistence Implementation
**Priority**: High
**Location**: `apps/frontend/hooks/useConnection.ts`
**Changes needed**:
- Store session IDs in `sessionStorage`
- Reuse existing sessions on page refresh
- Proper cleanup when tab closes
- Modify line 547: `sessionId: getStoredSessionId() || undefined`

### 2. AWS Documentation Server Fix
**Priority**: Medium
**Issue**: Environment variable configuration
**Fix**: Correct `FASTMCP_LOG_LEVEL` value or remove variable

### 3. Backend Session Cleanup
**Priority**: Medium
**Enhancement**: Implement session timeout and cleanup mechanisms
**Location**: `apps/backend/src/routers/public-metamcp/streamable-http.ts`

---

## Technical Impact Assessment

- **Severity**: High (system-wide connection failures)
- **Scope**: All users on deployed AWS instance
- **Downtime**: ~1 hour of degraded service
- **Recovery**: Immediate via container restart
- **Recurrence**: Will return on next page refresh until code fix deployed

---

## Monitoring Plan

1. **Session Count**: Monitor `/health/sessions` endpoint
2. **Error Patterns**: Watch for "Transport not found" errors
3. **User Behavior**: Track connection success rates
4. **Threshold**: If active sessions > 20, consider restart

**Key Rule**: Once working connection established, avoid refreshing until session persistence fix is deployed.

---

*Report generated: 2025-01-20*
*Status: Container restarted, monitoring in progress*
*Next: Deploy session persistence fix*