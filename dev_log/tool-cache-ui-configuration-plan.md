# Tool List Cache UI Configuration - Implementation Plan

**Date**: 2025-12-01  
**Status**: 📋 Planning  
**Priority**: Medium

## Executive Summary

This document outlines the plan to make tool list caching configuration available in the frontend UI, allowing users to:
- Toggle tool list caching on/off per namespace
- Configure cache TTL (time-to-live) per namespace
- Configure page size for paginated tool responses per namespace

**Rationale**: Since caching is **namespace-level** (not global), the configuration should be **per-namespace** in the namespace detail/edit pages.

---

## Recommended UI Location

### Primary Location: Namespace Detail Page

**Path**: `/namespaces/[uuid]` → **"Performance Settings"** or **"Cache Settings"** section

**Why This Location?**
1. ✅ **Namespace-scoped**: Caching applies at namespace level
2. ✅ **Contextual**: Users managing namespaces see performance settings
3. ✅ **Discoverable**: Natural place for namespace configuration
4. ✅ **Consistent**: Matches existing pattern (servers, tools, etc. are namespace-scoped)

### UI Placement Options

#### Option A: Dedicated "Performance" Tab (Recommended)
```
Namespace Detail Page
├── Overview Tab (default)
├── Servers Tab
├── Tools Tab
└── Performance Tab ← NEW
    ├── Tool List Caching
    │   ├── [✓] Enable caching
    │   ├── Cache TTL: [3600] seconds (1 hour)
    │   └── Page Size: [50] tools per page
    └── [Save] button
```

**Pros**:
- Clear separation of concerns
- Room for future performance settings
- Doesn't clutter main namespace view

**Cons**:
- Requires tab navigation
- One more click to access

#### Option B: Collapsible Section in Overview Tab
```
Namespace Detail Page → Overview Tab
├── Namespace Details (name, description, etc.)
├── Connection Status
└── Performance Settings (collapsible) ← NEW
    ├── Tool List Caching
    │   ├── [✓] Enable caching
    │   ├── Cache TTL: [3600] seconds
    │   └── Page Size: [50] tools per page
    └── [Save] button
```

**Pros**:
- Immediately visible
- No tab navigation needed
- Quick access

**Cons**:
- Can make overview tab cluttered
- Less room for future settings

#### Option C: In Edit Namespace Dialog (Advanced Settings)
```
Edit Namespace Dialog
├── Basic Settings
│   ├── Name
│   ├── Description
│   └── MCP Servers
└── Advanced Settings (collapsible) ← NEW
    ├── Tool List Caching
    │   ├── [✓] Enable caching
    │   ├── Cache TTL: [3600] seconds
    │   └── Page Size: [50] tools per page
```

**Pros**:
- Centralized configuration
- Matches existing edit pattern
- Less UI surface area

**Cons**:
- Hidden in "Advanced" section
- Less discoverable
- Requires opening edit dialog

### Recommendation: **Option A (Dedicated Performance Tab)**

**Rationale**:
- Best UX for future extensibility (can add more performance settings)
- Clear mental model (performance = separate concern)
- Professional appearance
- Matches common patterns in admin UIs

---

## Database Schema Changes

### Migration: Add Cache Configuration Fields

**File**: `apps/backend/src/db/schema.ts`

```typescript
export const namespacesTable = pgTable(
  "namespaces",
  {
    uuid: uuid("uuid").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    user_id: text("user_id").references(() => usersTable.id, {
      onDelete: "cascade",
    }),
    // NEW: Cache configuration fields
    tool_cache_enabled: boolean("tool_cache_enabled")
      .notNull()
      .default(true),
    tool_cache_ttl: integer("tool_cache_ttl")
      .notNull()
      .default(3600), // 1 hour in seconds
    tools_page_size: integer("tools_page_size")
      .notNull()
      .default(50),
  },
  // ... existing constraints
);
```

### Migration SQL

```sql
ALTER TABLE namespaces
  ADD COLUMN tool_cache_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN tool_cache_ttl INTEGER NOT NULL DEFAULT 3600,
  ADD COLUMN tools_page_size INTEGER NOT NULL DEFAULT 50;
```

---

## Backend Implementation

### 1. Update Zod Schemas

**File**: `packages/zod-types/src/namespaces.ts`

```typescript
export const UpdateNamespaceRequestSchema = z.object({
  uuid: z.string().uuid(),
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  mcpServerUuids: z.array(z.string().uuid()).optional(),
  user_id: z.string().nullable().optional(),
  // NEW: Cache configuration
  tool_cache_enabled: z.boolean().optional(),
  tool_cache_ttl: z.number().int().min(0).max(86400).optional(), // 0-24 hours
  tools_page_size: z.number().int().min(1).max(1000).optional(),
});
```

### 2. Update Repository

**File**: `apps/backend/src/db/repositories/namespaces.repo.ts`

```typescript
export async function update(
  uuid: string,
  data: {
    name?: string;
    description?: string;
    user_id?: string | null;
    tool_cache_enabled?: boolean;
    tool_cache_ttl?: number;
    tools_page_size?: number;
  }
): Promise<Namespace | null> {
  // ... existing update logic
  // Add new fields to update
}
```

### 3. Update Namespace Implementation

**File**: `apps/backend/src/trpc/namespaces.impl.ts`

```typescript
update: async (
  input: z.infer<typeof UpdateNamespaceRequestSchema>,
  userId: string,
): Promise<z.infer<typeof UpdateNamespaceResponseSchema>> => {
  // ... existing validation
  
  // NEW: Invalidate cache if cache settings changed
  const existingNamespace = await namespacesRepository.findByUuid(input.uuid);
  if (existingNamespace) {
    const cacheSettingsChanged = 
      (input.tool_cache_enabled !== undefined && 
       input.tool_cache_enabled !== existingNamespace.tool_cache_enabled) ||
      (input.tool_cache_ttl !== undefined && 
       input.tool_cache_ttl !== existingNamespace.tool_cache_ttl);
    
    if (cacheSettingsChanged) {
      // Invalidate namespace cache when settings change
      invalidateNamespaceCache(input.uuid);
    }
  }
  
  // ... rest of update logic
}
```

### 4. Update Cache Logic to Use Namespace Settings

**File**: `apps/backend/src/lib/metamcp/namespace-tool-cache.ts`

```typescript
// Add function to get namespace-specific TTL
async function getNamespaceCacheTTL(namespaceUuid: string): Promise<number> {
  const namespace = await namespacesRepository.findByUuid(namespaceUuid);
  if (namespace?.tool_cache_ttl !== undefined) {
    return namespace.tool_cache_ttl * 1000; // Convert to milliseconds
  }
  return getCacheTTL(); // Fallback to env var
}

// Update isStale() to check namespace-specific settings
async function isStale(
  entry: NamespaceToolCacheEntry,
  namespaceUuid: string
): Promise<boolean> {
  const namespace = await namespacesRepository.findByUuid(namespaceUuid);
  
  // Check if caching is disabled for this namespace
  if (namespace?.tool_cache_enabled === false) {
    return true; // Always stale (cache disabled)
  }
  
  const ttl = await getNamespaceCacheTTL(namespaceUuid);
  if (ttl === 0) {
    return entry.status === "stale";
  }
  const age = Date.now() - entry.timestamp;
  return age > ttl || entry.status === "stale";
}
```

**File**: `apps/backend/src/lib/metamcp/metamcp-proxy.ts`

```typescript
// Update to use namespace-specific page size
function getToolsPageSize(namespaceUuid: string): number {
  // Try to get from namespace settings first
  const namespace = await namespacesRepository.findByUuid(namespaceUuid);
  if (namespace?.tools_page_size) {
    return namespace.tools_page_size;
  }
  // Fallback to env var
  return getPageSizeFromEnv();
}
```

---

## Frontend Implementation

### 1. Create Performance Settings Component

**File**: `apps/frontend/app/[locale]/(sidebar)/namespaces/[uuid]/components/performance-settings.tsx`

```typescript
"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { trpc } from "@/trpc/client";
import { Loader2 } from "lucide-react";

const performanceSettingsSchema = z.object({
  tool_cache_enabled: z.boolean(),
  tool_cache_ttl: z.number().int().min(0).max(86400),
  tools_page_size: z.number().int().min(1).max(1000),
});

type PerformanceSettingsFormData = z.infer<typeof performanceSettingsSchema>;

interface PerformanceSettingsProps {
  namespaceUuid: string;
  initialValues: {
    tool_cache_enabled: boolean;
    tool_cache_ttl: number;
    tools_page_size: number;
  };
}

export function PerformanceSettings({
  namespaceUuid,
  initialValues,
}: PerformanceSettingsProps) {
  const [isSaving, setIsSaving] = useState(false);
  const utils = trpc.useUtils();

  const form = useForm<PerformanceSettingsFormData>({
    resolver: zodResolver(performanceSettingsSchema),
    defaultValues: initialValues,
  });

  const updateMutation = trpc.frontend.namespaces.update.useMutation({
    onSuccess: () => {
      toast.success("Performance settings updated");
      utils.frontend.namespaces.get.invalidate({ uuid: namespaceUuid });
    },
    onError: (error) => {
      toast.error("Failed to update settings", {
        description: error.message,
      });
    },
    onSettled: () => {
      setIsSaving(false);
    },
  });

  const onSubmit = async (data: PerformanceSettingsFormData) => {
    setIsSaving(true);
    updateMutation.mutate({
      uuid: namespaceUuid,
      ...data,
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Tool List Caching</CardTitle>
        <CardDescription>
          Configure caching behavior for tool list responses to improve performance
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
          {/* Enable Caching Toggle */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="cache-enabled">Enable Tool List Caching</Label>
              <p className="text-sm text-muted-foreground">
                Cache tool lists to reduce response time from ~40s to &lt;50ms
              </p>
            </div>
            <Switch
              id="cache-enabled"
              checked={form.watch("tool_cache_enabled")}
              onCheckedChange={(checked) =>
                form.setValue("tool_cache_enabled", checked)
              }
            />
          </div>

          {/* Cache TTL */}
          {form.watch("tool_cache_enabled") && (
            <>
              <div className="space-y-2">
                <Label htmlFor="cache-ttl">Cache Time-to-Live (seconds)</Label>
                <Input
                  id="cache-ttl"
                  type="number"
                  min="0"
                  max="86400"
                  {...form.register("tool_cache_ttl", { valueAsNumber: true })}
                />
                <p className="text-sm text-muted-foreground">
                  How long cached tools remain valid. 0 = never expires. Default: 3600 (1 hour)
                </p>
              </div>

              {/* Page Size */}
              <div className="space-y-2">
                <Label htmlFor="page-size">Tools Per Page</Label>
                <Input
                  id="page-size"
                  type="number"
                  min="1"
                  max="1000"
                  {...form.register("tools_page_size", { valueAsNumber: true })}
                />
                <p className="text-sm text-muted-foreground">
                  Number of tools returned per paginated request. Default: 50
                </p>
              </div>
            </>
          )}

          <Button type="submit" disabled={isSaving}>
            {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save Settings
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
```

### 2. Add Performance Tab to Namespace Detail Page

**File**: `apps/frontend/app/[locale]/(sidebar)/namespaces/[uuid]/page.tsx`

```typescript
// Add tabs
const [activeTab, setActiveTab] = useState<"overview" | "servers" | "tools" | "performance">("overview");

// In JSX, add Performance tab
<Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as typeof activeTab)}>
  <TabsList>
    <TabsTrigger value="overview">Overview</TabsTrigger>
    <TabsTrigger value="servers">Servers</TabsTrigger>
    <TabsTrigger value="tools">Tools</TabsTrigger>
    <TabsTrigger value="performance">Performance</TabsTrigger>
  </TabsList>
  
  <TabsContent value="performance">
    <PerformanceSettings
      namespaceUuid={uuid}
      initialValues={{
        tool_cache_enabled: namespace.tool_cache_enabled ?? true,
        tool_cache_ttl: namespace.tool_cache_ttl ?? 3600,
        tools_page_size: namespace.tools_page_size ?? 50,
      }}
    />
  </TabsContent>
</Tabs>
```

### 3. Update TypeScript Types

**File**: `packages/zod-types/src/namespaces.ts` (or wherever namespace types are defined)

```typescript
export interface Namespace {
  uuid: string;
  name: string;
  description?: string;
  // ... existing fields
  tool_cache_enabled?: boolean;
  tool_cache_ttl?: number;
  tools_page_size?: number;
}
```

---

## UI/UX Considerations

### Default Values

| Setting | Default | Rationale |
|---------|---------|-----------|
| `tool_cache_enabled` | `true` | Caching provides significant performance benefit |
| `tool_cache_ttl` | `3600` (1 hour) | Good balance between freshness and performance |
| `tools_page_size` | `50` | Optimal for most use cases, not too large/small |

### Validation Rules

| Setting | Min | Max | Validation |
|---------|-----|-----|------------|
| `tool_cache_ttl` | 0 | 86400 (24h) | 0 = never expires |
| `tools_page_size` | 1 | 1000 | Reasonable bounds |

### User Guidance

**Tooltips/Help Text**:
- **Enable Caching**: "Reduces tool list response time from ~40s to <50ms. Disable only if you need real-time tool updates."
- **Cache TTL**: "How long cached tools remain valid. Lower values = fresher data but more server load. 0 = never expires."
- **Page Size**: "Number of tools per page. Higher = fewer pages but slower first page. Lower = more pages but faster first page."

### Visual Indicators

- Show cache status badge: "Cache: Active" / "Cache: Disabled"
- Show cache age: "Last updated: 5 minutes ago"
- Show cache hit rate (if metrics available): "Cache hit rate: 98%"

---

## Implementation Steps

### Phase 1: Database & Backend
1. ✅ Create database migration
2. ✅ Update schema types
3. ✅ Update Zod schemas
4. ✅ Update repository methods
5. ✅ Update namespace implementation
6. ✅ Update cache logic to use namespace settings
7. ✅ Add cache invalidation on settings change

### Phase 2: Frontend
1. ✅ Create PerformanceSettings component
2. ✅ Add Performance tab to namespace detail page
3. ✅ Update TypeScript types
4. ✅ Add translations (i18n)
5. ✅ Add form validation
6. ✅ Add loading/error states

### Phase 3: Testing
1. ✅ Unit tests for cache logic with namespace settings
2. ✅ Integration tests for settings update
3. ✅ E2E tests for UI flow
4. ✅ Performance testing with different settings

---

## Alternative: Global Settings (Not Recommended)

**Why Not?**
- ❌ Caching is namespace-scoped, not global
- ❌ Different namespaces may have different performance needs
- ❌ Less flexible for users managing multiple namespaces

**If Needed**: Could add global defaults in Settings page, but namespace settings should override.

---

## Future Enhancements

1. **Cache Statistics Dashboard**: Show cache hit rate, memory usage, refresh frequency
2. **Cache Invalidation Button**: Manual "Refresh Cache" button
3. **Cache Preview**: Show what's currently cached
4. **Smart Defaults**: Suggest optimal settings based on namespace size
5. **Bulk Operations**: Apply settings to multiple namespaces

---

## Migration Strategy

### For Existing Namespaces

```sql
-- All existing namespaces get defaults
UPDATE namespaces
SET 
  tool_cache_enabled = true,
  tool_cache_ttl = 3600,
  tools_page_size = 50
WHERE tool_cache_enabled IS NULL;
```

This ensures backward compatibility - existing namespaces continue working with sensible defaults.

---

## Summary

**Best Location**: Namespace Detail Page → **Performance Tab**

**Why**: 
- Caching is namespace-scoped
- Natural place for namespace configuration
- Room for future performance settings
- Professional, discoverable UI

**Implementation**: 
- Add 3 fields to `namespaces` table
- Update backend to use namespace-specific settings
- Create PerformanceSettings component
- Add Performance tab to namespace detail page

**User Experience**:
- Toggle caching on/off
- Configure TTL (0-24 hours)
- Configure page size (1-1000)
- Clear defaults and validation
- Visual feedback on cache status

