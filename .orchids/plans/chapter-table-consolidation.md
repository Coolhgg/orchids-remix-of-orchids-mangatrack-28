# Chapter Table Consolidation Plan

## Requirements

Consolidate the chapter data architecture by removing the legacy empty `Chapter` table (`chapters`) and ensuring all code references the correct `LogicalChapter` table (`logical_chapters`). This will eliminate "Chapter Not Found" errors and database confusion caused by inconsistent table usage.

## Current State Analysis

### Database Tables

| Model | DB Table | Rows | Purpose | Status |
|-------|----------|------|---------|--------|
| `LogicalChapter` | `logical_chapters` | 2,493 | **Modern canonical source** for chapters | Active |
| `Chapter` | `chapters` | **0** | Legacy table from v1 ingestion | **Empty, deprecated** |
| `LegacyChapter` | `legacy_chapters` | 2,493 | Historical per-source chapter data | Reference only |

### Problem
The codebase has **inconsistent table usage** - some code queries the empty `chapters` table while data lives in `logical_chapters`, causing "Chapter Not Found" errors.

### Schema Comparison

Both tables have nearly identical columns:

| Column | `Chapter` (`chapters`) | `LogicalChapter` (`logical_chapters`) |
|--------|------------------------|---------------------------------------|
| `id` | UUID | UUID |
| `series_id` | UUID (nullable) | UUID (not null) |
| `chapter_number` | VARCHAR(100) | String (nullable) |
| `volume_number` | Int? | Int? |
| `chapter_title` | VARCHAR(500) | VARCHAR(500) |
| `page_count` | Int? | Int? |
| `published_at` | Timestamptz | Timestamptz |
| `first_seen_at` | Timestamptz | Timestamptz |
| `updated_at` | Timestamptz | Timestamptz |
| `deleted_at` | Timestamptz | Timestamptz |
| `chapter_slug` | VARCHAR(100) | VARCHAR(100) |
| `read_at` | Timestamptz | Timestamptz |
| **Relations** | None (orphaned) | ChapterSource, ChapterLink, FeedEntry, etc. |

## Files Requiring Changes

### Priority 1: API Routes (Critical Path)

| File | Lines | Issue | Fix |
|------|-------|-------|-----|
| `src/app/api/library/[id]/progress/route.ts` | 169, 195, 440-448 | `tx.chapter.findFirst()` and `FROM chapters` raw SQL | Change to `tx.logicalChapter.findFirst()` and `FROM logical_chapters` |
| `src/app/api/sync/replay/route.ts` | 87-95 | `tx.chapter.findUnique()` | Change to `tx.logicalChapter.findUnique()` |

### Priority 2: Raw SQL Queries (Feed/Notifications)

| File | Lines | Issue | Fix |
|------|-------|-------|-----|
| `src/lib/feed-eligibility.ts` | 99, 126, 142, 153 | `FROM chapters lc` | Change to `FROM logical_chapters lc` |
| `src/lib/sql/production-queries.ts` | 22, 33, 316-324, 339-344, 384-393, 410, 457, 484 | Multiple `FROM chapters` references | Change to `FROM logical_chapters` |
| `src/lib/notifications-timing.ts` | 25, 69-76 | `FROM chapters c` and `JOIN chapters c` | Change to `FROM logical_chapters c` and `JOIN logical_chapters c` |

### Priority 3: SQL Files

| File | Lines | Issue | Fix |
|------|-------|-------|-----|
| `src/lib/sql/chapter-timeline.sql` | 74, 92 | `FROM chapters c` | Change to `FROM logical_chapters c` |
| `src/lib/sql/trending-score.sql` | 29 | `FROM chapters lc` | Change to `FROM logical_chapters lc` |
| `src/lib/sql/discover-materialized-views.sql` | 41, 147 | `FROM chapters lc` | Change to `FROM logical_chapters lc` |

### Priority 4: Test Files

| File | Changes Needed |
|------|----------------|
| `src/__tests__/integration/core-flow.test.ts` | `prisma.chapter.deleteMany` -> `prisma.logicalChapter.deleteMany` |
| `src/__tests__/integration/sync-replay.test.ts` | Mock `prisma.logicalChapter.findUnique` instead of `prisma.chapter.findUnique` |
| `src/__tests__/integration/worker-safety.test.ts` | Mock `prisma.logicalChapter.findMany` |
| `src/__tests__/integration/worker-idempotency.test.ts` | Mock `prisma.logicalChapter.findMany` |
| `src/__tests__/integration/sync.test.ts` | Expect `prisma.logicalChapter.upsert` |
| `src/__tests__/integration/sync-logic.test.ts` | Use `prisma.logicalChapter.findMany` |
| `src/__tests__/integration/transaction-rollback.test.ts` | Use `prisma.logicalChapter.createMany/deleteMany` |
| `src/__tests__/integration/read-progress-xp-spec.test.ts` | Use `prisma.logicalChapter.createMany/deleteMany` and fix raw SQL |
| `src/__tests__/integration/notification-timing.test.ts` | Use `prisma.logicalChapter.create/deleteMany` |
| `src/__tests__/integration/ingestion.test.ts` | Mock `prisma.logicalChapter` methods |
| `src/__tests__/integration/progress-race-condition.test.ts` | Fix raw SQL to use `logical_chapters` |

### Priority 5: Scripts (Non-Critical)

| File | Changes Needed |
|------|----------------|
| `scripts/verify-source-weighting.ts` | Use `prisma.logicalChapter` |
| `scripts/verify-tier-system.ts` | Use `prisma.logicalChapter` |
| `scripts/test/test-chapter-schema.ts` | Use `prisma.logicalChapter` |
| `scripts/qa-availability-feed.ts` | Use `prisma.logicalChapter` and fix raw SQL |
| `scripts/qa/verify-availability-feed.ts` | Use `prisma.logicalChapter` |
| `scripts/force-sync-series.ts` | Use `prisma.logicalChapter` |

### Priority 6: Documentation Updates

| File | Changes Needed |
|------|----------------|
| `docs/CHAPTER_INGESTION_WORKER_ARCHITECTURE.md` | Update examples to use `prisma.logicalChapter` |
| `docs/sql-query-map.md` | Update SQL examples |
| `docs/sql-query-reference.md` | Update SQL examples |
| `docs/database-debugging-guide.md` | Update SQL examples |

## Implementation Phases

### Phase 1: Fix Critical API Routes
1. Update `src/app/api/library/[id]/progress/route.ts`:
   - Line 169: `tx.chapter.findFirst` -> `tx.logicalChapter.findFirst`
   - Line 195: `tx.chapter.findFirst` -> `tx.logicalChapter.findFirst`
   - Lines 440-448: Change raw SQL `FROM chapters` to `FROM logical_chapters`
2. Update `src/app/api/sync/replay/route.ts`:
   - Line 87: `tx.chapter.findUnique` -> `tx.logicalChapter.findUnique`

### Phase 2: Fix Raw SQL in Core Libraries
1. Update `src/lib/feed-eligibility.ts`:
   - Replace all `FROM chapters` with `FROM logical_chapters`
2. Update `src/lib/sql/production-queries.ts`:
   - Replace all `FROM chapters` and `JOIN chapters` with `logical_chapters`
3. Update `src/lib/notifications-timing.ts`:
   - Replace all `FROM chapters` and `JOIN chapters` with `logical_chapters`

### Phase 3: Fix SQL Files
1. Update `src/lib/sql/chapter-timeline.sql`
2. Update `src/lib/sql/trending-score.sql`
3. Update `src/lib/sql/discover-materialized-views.sql`

### Phase 4: Update Test Files
1. Fix all integration tests to use `prisma.logicalChapter`
2. Update mocks to reference correct model
3. Fix raw SQL in test queries

### Phase 5: Update Scripts
1. Update QA and verification scripts
2. Update force-sync and maintenance scripts

### Phase 6: Remove Legacy Chapter Model
1. Create Prisma migration to drop `Chapter` model
2. Remove `Chapter` model from `prisma/schema.prisma`
3. Run `prisma generate` to update client

### Phase 7: Documentation Cleanup
1. Update architecture docs
2. Update SQL reference docs

## Verification Checklist

Before proceeding with each phase:

- [ ] Run `grep -r "prisma.chapter\." src/` to find remaining Prisma references
- [ ] Run `grep -r "FROM chapters" src/` to find remaining raw SQL references
- [ ] Run `npm test` to verify tests pass
- [ ] Test chapter link submission manually
- [ ] Test reading progress updates manually
- [ ] Verify feeds load correctly

## Rollback Plan

If issues arise:
1. **Phase 1-5**: Revert file changes via git
2. **Phase 6**: Migration includes `DROP TABLE` - requires database restore from backup

## Risk Assessment

| Phase | Risk | Mitigation |
|-------|------|------------|
| Phase 1 | High - Core user flow | Test thoroughly before deploying |
| Phase 2 | Medium - Feeds may break | Monitor feed endpoints post-deploy |
| Phase 3 | Low - SQL files may not be actively used | Verify usage before changing |
| Phase 4 | Low - Tests only | Run full test suite |
| Phase 5 | Low - Scripts are manual | Can fix on-demand |
| Phase 6 | **Critical** - Irreversible | Take database backup first |

## Success Criteria

1. Zero "Chapter Not Found" errors in logs
2. All tests passing
3. Chapter link submission works for all series
4. Reading progress updates work correctly
5. Feeds display chapter data correctly
6. No remaining references to `prisma.chapter` or `FROM chapters` in active code
