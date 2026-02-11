# Worker TypeScript Fixes Plan

## Current Status

| Test Suite | Status | Result |
|------------|--------|--------|
| **API Tests** (`bun test tests/api/`) | PASS | 40/40 tests passing |
| **TypeScript** (production code) | PASS | 0 errors in `src/app/`, `src/lib/`, `src/components/` |
| **TypeScript** (workers) | NEEDS FIX | ~50 errors in `src/workers/` |
| **TypeScript** (tests/scripts) | Non-blocking | ~106 errors (test infrastructure) |
| **Playwright E2E** | Cannot run | Missing `libglib-2.0.so.0` system library (environment limitation) |

## Root Cause

The `src/workers/` directory contains background job processors that use **lowercase Prisma relation names** (`series`, `user`, `chapter`) instead of the required **PascalCase names** (`Series`, `users`, `LogicalChapter`) per AGENTS.md conventions.

## Files Requiring Fixes

### Priority 1: Processors (Core Worker Logic)

| File | Errors | Fix Pattern |
|------|--------|-------------|
| `feed-ingest.processor.ts` | 14 | `series` → `Series`, `feedIngestRun` → check model name |
| `notification.processor.ts` | 9 | `series_source` → `SeriesSource`, `user` → `users`, `chapter` → `LogicalChapter` |
| `poll-source.processor.ts` | 5 | `chapter` → `LogicalChapter`, `series` → `Series` |
| `feed-fanout.processor.ts` | 3 | `user` → `users` |
| `notification-timing.processor.ts` | 3 | `series_source` → `SeriesSource` |
| `notification-digest.processor.ts` | 2 | `series` → `Series` |
| `chapter-ingest.processor.ts` | 4 | `series` → `Series`, `chapter` → `LogicalChapter` |
| `canonicalize.processor.ts` | 2 | `series` → `Series` |
| `latest-feed.processor.ts` | 2 | `series` → `Series` |

### Priority 2: Schedulers

| File | Errors | Fix Pattern |
|------|--------|-------------|
| `deferred-search.scheduler.ts` | 3 | `queryStats` → `queryStat` |
| `master.scheduler.ts` | 2 | `series` → `Series` |
| `cover-refresh.scheduler.ts` | 1 | `series` → `Series` |
| `metadata-healing.scheduler.ts` | 1 | `series` → `Series` |

## Detailed Fix Patterns

### Pattern 1: Relation Include/Select
```typescript
// BEFORE (incorrect)
include: { series: true }

// AFTER (correct per AGENTS.md)
include: { Series: true }
```

### Pattern 2: Relation Access
```typescript
// BEFORE (incorrect)
source.series.title

// AFTER (correct)
source.Series?.title
```

### Pattern 3: Where Clauses with Relations
```typescript
// BEFORE (incorrect)
where: { user: { id: userId } }

// AFTER (correct)
where: { users: { id: userId } }
```

### Pattern 4: Model Names (Singular)
```typescript
// BEFORE (incorrect)
prisma.queryStats.findMany()

// AFTER (correct per AGENTS.md - singular model names)
prisma.queryStat.findMany()
```

### Pattern 5: Field Name Mismatches
```typescript
// BEFORE (incorrect)
last_chapter_released_at

// AFTER (check schema)
last_chapter_date
```

## Schema Reference (from AGENTS.md)

Per project conventions:
- **Models**: PascalCase singular (`User`, `Series`, `LibraryEntry`)
- **Tables**: snake_case plural (`users`, `series`, `library_entries`)
- **Singular relations**: camelCase singular (`user User`, `series Series`)
- **Collection relations**: camelCase plural (`activities Activity[]`)

## Implementation Steps

1. Fix `feed-ingest.processor.ts` (14 errors - highest impact)
2. Fix `notification.processor.ts` (9 errors)
3. Fix `poll-source.processor.ts` (5 errors)
4. Fix remaining processors
5. Fix schedulers
6. Run `bunx tsc --noEmit` to verify

## Non-Blocking Errors (Test Infrastructure)

The following errors are in test files and don't affect production:
- `tests/api/*.test.ts`: Cannot find module 'bun:test' (type definitions missing)
- `src/__tests__/*.ts`: Various test-specific type issues

These can be fixed in a separate maintenance pass by:
1. Adding `@types/bun` or using `/// <reference types="bun-types" />`
2. Updating test mocks to match current interfaces

## E2E Test Environment Note

Playwright E2E tests require system libraries (`libglib-2.0.so.0`, etc.) that are not available in this sandbox environment. To run E2E tests:

```bash
# In CI/CD or local environment with proper dependencies:
npx playwright install --with-deps chromium
npx playwright test
```

This is an **environment limitation**, not a code issue.
