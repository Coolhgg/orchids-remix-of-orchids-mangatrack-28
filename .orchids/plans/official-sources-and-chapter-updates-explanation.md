# Official Sources, Chapter Updates & Tier Recognition - Complete Explanation

## Executive Summary

Your questions cover several related topics. Let me explain how the system currently works:

---

## 1. Official Sources (VIZ, MangaPlus, K Manga)

### Current Status: ✅ SUPPORTED (Recognition + No Scraping)

**How it works:**
- The system **recognizes** official sources by domain (see `src/lib/chapter-links/constants.ts`)
- **NO scraping** is done for any source - only official APIs are used
- Official links come from **AniList API** which provides external links to official publishers

**Official Domains Supported:**
```
viz.com              → VIZ Media
mangaplus.shueisha.co.jp → MANGA Plus  
shonenjump.com       → Shonen Jump
kodansha.us          → Kodansha
comikey.com          → Comikey
azuki.co             → Azuki
webtoons.com         → WEBTOON
tappytoon.com        → Tappytoon
```

**The Flow:**
```
Series imported → AniList lookup by ID/title → Get external links → Store official URLs
```

---

## 2. User Manual Link Pasting Feature

### Current Status: ✅ FULLY IMPLEMENTED

**API Endpoint:** `POST /api/series/:seriesId/chapters/:chapterId/links`

**How Users Submit Links:**
1. User navigates to a chapter
2. Clicks "Add Link" or similar UI
3. Pastes a URL
4. System validates:
   - URL format validity
   - Not on blacklist (URL shorteners, ad links blocked)
   - Not a social media link
   - Source tier determined automatically

**Rate Limits:**
- New users: 5 links/day
- Established users: 20 links/day
- Trust level 10+ users: Auto-approved links

**Source Tier Auto-Detection:**
```typescript
// From src/lib/chapter-links/url-utils.ts
getSourceTier(domain):
  - Official domains → tier: 'official' (highest trust)
  - mangadex.org → tier: 'aggregator' (trusted)
  - Other → tier: 'user' (needs moderation)
```

---

## 3. Tier Recognition System

### How It Works:

```
┌─────────────────────────────────────────────────────────────────┐
│ TIER 1: OFFICIAL SOURCES (Auto-linked, highest priority)       │
│ - VIZ, MangaPlus, Kodansha, etc.                               │
│ - Links displayed with direct URLs                              │
│ - From AniList external links                                   │
├─────────────────────────────────────────────────────────────────┤
│ TIER 2: TRUSTED AGGREGATORS (MangaDex)                         │
│ - Chapters synced automatically                                 │
│ - Direct links to read on MangaDex                             │
│ - Primary metadata source                                       │
├─────────────────────────────────────────────────────────────────┤
│ TIER 3: MANGAUPDATES RELEASE METADATA                          │
│ - Shows group name ONLY (no direct links)                       │
│ - Shows chapter number and date                                 │
│ - Informational only - user searches on their own              │
├─────────────────────────────────────────────────────────────────┤
│ TIER 4: USER-SUBMITTED LINKS                                   │
│ - Requires moderation unless high trust user                    │
│ - Displayed after approval                                      │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. Chapter Updates Flow

### Data Sources:

| Source | What We Get | How It's Used |
|--------|------------|---------------|
| **MangaDex** | Chapters with URLs | Direct reading links |
| **MangaUpdates** | Release metadata (group name, chapter #) | "Available On" display |
| **AniList** | Official publisher links | Direct links to VIZ, etc. |

### The Process:

```
1. Series Added to Library
   ↓
2. Metadata Enrichment Job
   ↓
3. MangaDex Lookup → Get chapters, cover, description
   ↓
4. AniList Lookup → Get official external links (VIZ, MangaPlus URLs)
   ↓
5. MangaUpdates Poller → Get release info (group names, chapter numbers)
   ↓
6. Display on Series Page:
   - Official sources: Direct links
   - MangaDex: Direct links
   - Scanlation groups: Name only (no link)
```

---

## 5. The Fox Manga Example

### Series: "The Story of the Fox Who Was Late Getting Married and Came to Be My Bride"
### Japanese: "Totsugi Okureta Kitsune ga Yome ni Kuru Hanashi"

**What Currently Happens:**
1. Search finds it on MangaDex ✅
2. MangaUpdates has release data ✅
3. Data stored in `mangaupdates_releases` table ✅

**What's Missing (Your Concern):**
The releases in `mangaupdates_releases` are **not linked to the local series record** because:
- `series_id` column is NULL for most releases
- The matching between MangaUpdates series ID and local series needs to happen

**The Fix Already Implemented:**
- `ReleaseInfoCard` component displays "Available On" metadata
- `/api/series/:id/releases` endpoint serves the data
- Shows group name WITHOUT direct links

---

## 6. Why Pirate Sites Don't Show Links

### By Design:

The system intentionally does NOT:
- Link to pirate/scanlation sites
- Scrape any websites
- Provide reading URLs for unofficial sources

**What It DOES Show:**
```
"Available On: [Scanlation Group Name]"
"Latest Chapter: 45"
"Last Updated: 2 days ago"
```

This is **metadata only** - informing users where content exists without facilitating piracy.

---

## 7. Verification Tests

### Test 1: TypeScript Compilation
```bash
bunx tsc --noEmit
```
**Expected:** 0 errors in production code (src/app/, src/lib/, src/components/)

### Test 2: API Tests
```bash
bun test tests/api/
```
**Expected:** 40/40 tests passing

### Test 3: E2E Tests
```bash
npx playwright test
```
**Note:** Requires proper environment (not sandbox) due to system library dependencies

---

## 8. Database State

### Current Status:
- `mangaupdates_releases`: 1,194 entries
- `series` with `mangaupdates_series_id`: 0 (needs linking)

### The Gap:
Releases exist but aren't linked to series because:
1. Series don't have `mangaupdates_series_id` populated
2. Need a worker to match by title similarity

---

## Summary Table

| Feature | Status | Notes |
|---------|--------|-------|
| Official source recognition | ✅ | VIZ, MangaPlus, etc. |
| AniList integration | ✅ | Official links |
| MangaDex integration | ✅ | Primary chapters |
| MangaUpdates releases | ✅ | Data stored |
| User link submission | ✅ | With moderation |
| ReleaseInfoCard component | ✅ | Shows "Available On" |
| Releases API endpoint | ✅ | `/api/series/:id/releases` |
| Series-Release linking | ⚠️ | Needs population |
| Direct pirate links | ❌ | By design - never |

---

## Next Steps to Show Release Metadata

1. **Link releases to series** by matching `mangaupdates_series_id`
2. **The ReleaseInfoCard** will then display automatically on series pages
3. **Users will see:** "Available On: [Group Name]" with chapter info but NO links

This maintains legal compliance while being informative.
