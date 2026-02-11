# Implementation Plan: MangaUpdates Release Linking

## Problem Statement

The MangaUpdates release metadata exists in the database (`mangaupdates_releases` table with 1,194 entries) but is not displayed on series pages because the `series_id` foreign key is NULL for all releases. The series also lack `mangaupdates_series_id` values.

## Solution Overview

Link MangaUpdates releases to local series records so the `ReleaseInfoCard` component can display "Available On" metadata.

---

## Implementation Phases

### Phase 1: Populate Series MangaUpdates IDs

**Goal:** Set `mangaupdates_series_id` on series records

**Approach:**
1. During metadata enrichment (import processor), search MangaUpdates by title
2. Store the matched `series_id` from MangaUpdates on the local series record
3. Use fuzzy title matching to handle translations/variations

**Files to modify:**
- `src/workers/processors/import.processor.ts`
- `src/lib/mangaupdates/client.ts` (search by title function exists)

### Phase 2: Link Releases to Series

**Goal:** Populate `series_id` in `mangaupdates_releases`

**Approach:**
1. Create a background job that matches releases to series
2. Match by `mangaupdates_series_id` (from release) → local series with same MU ID
3. Run periodically to catch new releases

**New file:**
- `src/workers/processors/release-linker.processor.ts`

### Phase 3: UI Integration (Already Done)

**Components already created:**
- `src/components/series/ReleaseInfoCard.tsx` - Displays "Available On" card
- `src/app/api/series/[id]/releases/route.ts` - API endpoint

**Integration point:**
- `src/app/(public)/series/[id]/page.tsx` - ReleaseInfoCard imported and placed

---

## Data Flow After Implementation

```
1. Series added to library
   ↓
2. Import processor enriches metadata
   ↓  
3. MangaUpdates search by title → Get series_id
   ↓
4. Store mangaupdates_series_id on series record
   ↓
5. MangaUpdates poller fetches releases (existing)
   ↓
6. Release linker job matches releases to series by MU ID
   ↓
7. ReleaseInfoCard fetches via /api/series/:id/releases
   ↓
8. User sees "Available On: [Group Name]" with chapter info
```

---

## API Already Implemented

### GET /api/series/:id/releases

**Response:**
```json
{
  "releases": [
    {
      "id": "uuid",
      "title": "Series Title",
      "chapter": "45",
      "volume": null,
      "language": null,
      "published_at": "2026-01-28T00:00:00.000Z",
      "groups": [
        { "name": "Scanlation Group", "id": 12345 }
      ]
    }
  ],
  "source": "database",
  "mangaupdates_series_id": 31825578571
}
```

---

## Test Verification Commands

```bash
# TypeScript compilation
bunx tsc --noEmit

# API tests  
bun test tests/api/

# E2E tests (requires proper environment)
npx playwright test
```

---

## Current Test Results

| Test Suite | Result |
|------------|--------|
| TypeScript (production) | ✅ 0 errors |
| API Tests | ✅ 40/40 passing |
| E2E Tests | ⚠️ Requires CI environment |

---

## Remaining Work

1. **Modify import processor** to fetch MangaUpdates series ID during enrichment
2. **Create release linker worker** to batch-link releases to series
3. **Test end-to-end** with the Fox manga example

---

## Expected User Experience After Implementation

On the series detail page sidebar, users will see:

```
┌─────────────────────────────────────┐
│ 👥 Available On          Unofficial │
├─────────────────────────────────────┤
│ [AS] Asura Scans                    │
│      Ch. 45 · 2d ago               │
├─────────────────────────────────────┤
│ [LS] Luminous Scans                 │
│      Ch. 44 · 5d ago               │
├─────────────────────────────────────┤
│ ⚠️ These are unofficial sources.   │
│    Links are not provided.          │
└─────────────────────────────────────┘
```

This shows WHERE content is available without providing direct links to pirate sites.
