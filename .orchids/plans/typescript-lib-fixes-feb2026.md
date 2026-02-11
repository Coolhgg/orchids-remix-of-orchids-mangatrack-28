# TypeScript Library Fixes Plan - February 2026

## Overview
This plan documents the remaining 39 TypeScript errors in `src/lib/` utility files and provides the specific fixes needed to resolve them.

---

## Error Summary by File

| File | Error Count | Root Cause |
|------|-------------|------------|
| `src/lib/trending.ts` | 9 | Uses `chapter` (lowercase), `added_at` (non-existent field) |
| `src/lib/social-utils.ts` | 8 | Uses `series`, `chapter`, `actor`, `follower` (lowercase) |
| `src/lib/catalog-tiers.ts` | 6 | Already partially fixed, remaining null checks |
| `src/lib/cover-resolver.ts` | 3 | `PrismaPromise` vs `Promise` type mismatch |
| `src/lib/search-utils.ts` | 5 | `queryStats` should be `queryStat` |
| `src/lib/search-cache.ts` | 1 | Boolean type in error handling |
| `src/lib/sync/import-pipeline.ts` | 4 | Relation names need PascalCase |
| `src/lib/worker-error-boundary.ts` | 1 | Type inference issue |
| `src/lib/supabase/middleware.ts` | 1 | Spread type (already fixed) |

---

## Detailed Fixes

### 1. `src/lib/trending.ts`

**Line 44, 47**: `chapter` → `Chapter` or use `logicalChapter`
```typescript
// WRONG
prisma.chapter.findMany({
  where: { series_id: seriesId, first_detected_at: ... }
})

// CORRECT - Use LogicalChapter model
prisma.logicalChapter.findMany({
  where: { series_id: seriesId, first_detected_at: ... }
})
```

**Line 52**: `added_at` doesn't exist on LibraryEntry, use `created_at`
```typescript
// WRONG
where: { added_at: { gte: seventyTwoHoursAgo } }

// CORRECT
where: { created_at: { gte: seventyTwoHoursAgo } }
```

**Line 66, 68**: Fix property access after model change
```typescript
// WRONG
chapters.filter(c => c.first_detected_at && ...)
follows.filter(f => f.added_at >= ...)

// CORRECT
chapters.filter(c => c.first_detected_at && ...)  // OK if using LogicalChapter
follows.filter(f => f.created_at >= twentyFourHoursAgo)
```

**Line 83**: Reduce callback with null handling
```typescript
// Add explicit type annotation
chapters.reduce((latest, c) => 
  c.first_detected_at && (!latest || c.first_detected_at > latest) 
    ? c.first_detected_at 
    : latest, 
  null as Date | null
)
```

---

### 2. `src/lib/social-utils.ts`

**Lines 42, 49, 56**: Notification include relations need PascalCase
```typescript
// WRONG
include: {
  series: { select: { id: true, title: true, cover_url: true } },
  chapter: { select: { id: true, chapter_number: true } },
  actor: { select: { id: true, username: true } },
}

// CORRECT - Per Prisma schema
include: {
  Series: { select: { id: true, title: true, cover_url: true } },
  LogicalChapter: { select: { id: true, chapter_number: true } },
  users_notifications_actor_user_idTousers: { 
    select: { id: true, username: true, avatar_url: true } 
  },
}
```

**Lines 146, 160**: Follow relations need PascalCase
```typescript
// WRONG
include: { follower: { select: { ... } } }

// CORRECT - Per Prisma schema
include: { 
  users_follows_follower_idTousers: { 
    select: { id: true, username: true, avatar_url: true } 
  } 
}
```

**Lines 206, 220**: Similar fix for following relation
```typescript
// CORRECT
include: {
  users_follows_following_idTousers: {
    select: { id: true, username: true, avatar_url: true }
  }
}
```

---

### 3. `src/lib/search-utils.ts`

**Lines 54, 110, 132, 142, 152**: `queryStats` should be `queryStat`
```typescript
// WRONG
await prisma.queryStats.create({ ... })

// CORRECT - Model name is QueryStat (singular)
await prisma.queryStat.create({ ... })
```

---

### 4. `src/lib/cover-resolver.ts`

**Lines 26, 54, 111**: Add explicit Promise return
```typescript
// WRONG
return prisma.seriesSource.findMany({ ... })

// CORRECT - Await the result
return await prisma.seriesSource.findMany({ ... })
```

Or change the return type:
```typescript
// Alternative: Change function signature
async function getCovers(): Promise<SourceCover[]> {
  const results = await prisma.seriesSource.findMany({ ... })
  return results as SourceCover[]
}
```

---

### 5. `src/lib/sync/import-pipeline.ts`

**Line 224**: Use correct relation name for ImportJob → ImportItem
```typescript
// WRONG
include: { items: true }

// CORRECT
include: { ImportItem: true }
```

**Lines 257, 665**: Access the correct property
```typescript
// WRONG
job.items.map(i => ...)

// CORRECT
job.ImportItem.map(i => ...)
```

---

### 6. `src/lib/search-cache.ts`

**Line 1093**: Fix boolean type in error handling
```typescript
// WRONG
const result = await someOperation() // returns boolean | Error

// CORRECT - Add type guard
if (result instanceof Error) {
  throw result
}
```

---

### 7. `src/lib/worker-error-boundary.ts`

**Line 265**: Fix type inference
```typescript
// Add explicit type annotation to resolve inference issue
const result: WorkerResult = await processor(job)
```

---

## Implementation Priority

### High Priority (Production Impact)
1. `src/lib/social-utils.ts` - Affects notifications and social features
2. `src/lib/trending.ts` - Affects trending calculations
3. `src/lib/sync/import-pipeline.ts` - Affects library imports

### Medium Priority (Utility Functions)
4. `src/lib/search-utils.ts` - Search analytics
5. `src/lib/cover-resolver.ts` - Cover image resolution
6. `src/lib/catalog-tiers.ts` - Catalog tier management

### Low Priority (Edge Cases)
7. `src/lib/search-cache.ts` - Cache error handling
8. `src/lib/worker-error-boundary.ts` - Worker error handling

---

## Prisma Schema Reference

Key relation names from `prisma/schema.prisma`:

| Model | Relation Name | Type |
|-------|---------------|------|
| Series | `SeriesSource` | SeriesSource[] |
| Series | `LogicalChapter` | LogicalChapter[] |
| Series | `Chapter` | Chapter[] |
| Series | `SeriesStat` | SeriesStat? |
| Series | `SeedListEntry` | SeedListEntry[] |
| Notification | `Series` | Series? |
| Notification | `LogicalChapter` | LogicalChapter? |
| Notification | `users_notifications_actor_user_idTousers` | User? |
| Follow | `users_follows_follower_idTousers` | User |
| Follow | `users_follows_following_idTousers` | User |
| ImportJob | `ImportItem` | ImportItem[] |
| ChapterLink | `LinkVote` | LinkVote[] |
| ChapterLink | `ChapterLinkReport` | ChapterLinkReport[] |

---

## Verification Steps

After implementing fixes:

1. Run TypeScript check:
   ```bash
   bunx tsc --noEmit 2>&1 | grep "^src/lib" | wc -l
   # Target: 0 errors
   ```

2. Run affected tests:
   ```bash
   bun test src/__tests__/lib/
   ```

3. Verify dev server compiles:
   ```bash
   bun run dev
   # Should start without TypeScript errors
   ```

---

## Notes

- All relation names in Prisma include blocks MUST use PascalCase as defined in the schema
- The schema uses explicit relation names for User relations (e.g., `users_follows_follower_idTousers`)
- `added_at` field doesn't exist on LibraryEntry - use `created_at` instead
- `queryStats` model is actually named `queryStat` (singular)
