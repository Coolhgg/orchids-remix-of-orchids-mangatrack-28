# Official Sources and Chapter Updates - Feature Status Report

## Current Implementation Status

### 1. Official Sources Support ✅ IMPLEMENTED

The system recognizes and prioritizes these official sources (from `src/lib/chapter-links/constants.ts`):

**Tier 1 - Official Publishers (Auto-linked, highest trust):**
- VIZ Media (`viz.com`)
- MANGA Plus (`mangaplus.shueisha.co.jp`)
- Shonen Jump (`shonenjump.com`)
- Kodansha (`kodansha.us`, `kodansha.com`)
- Comikey (`comikey.com`)
- Azuki (`azuki.co`)
- INKR (`inkr.com`)
- comiXology (`comixology.com`)
- Amazon Kindle (`amazon.com`, `amazon.co.jp`)
- BookWalker (`bookwalker.jp`, `bookwalker.com`)
- WEBTOON (`webtoons.com`)
- Tappytoon (`tappytoon.com`)
- Lezhin Comics (`lezhin.com`)
- Tapas (`tapas.io`)
- And more...

**Tier 2 - Trusted Aggregators:**
- MangaDex (`mangadex.org`)

### 2. Data Sources for Metadata ✅ IMPLEMENTED

| Source | Purpose | Status |
|--------|---------|--------|
| **MangaDex** | Primary metadata, chapters, covers | ✅ Active |
| **MangaUpdates** | Release tracking, group info, ratings | ✅ Active |
| **AniList** | Official links, external IDs, tracking | ✅ Active |

### 3. How Chapter Updates Work

#### MangaUpdates Integration
The system polls MangaUpdates API for releases which include:
- Chapter/Volume numbers
- **Release group names** (scanlation groups or official)
- Release dates
- Series metadata

This data is stored in `mangaupdates_releases` table and linked to series.

#### The Tier Recognition System
```
Priority 1: MangaDex chapters (direct links, official scanlations)
     ↓
Priority 2: Official sources via AniList external links
     ↓  
Priority 3: MangaUpdates release metadata (shows group name, chapter info)
```

### 4. User Manual Link Submission ✅ IMPLEMENTED

**Endpoint:** `POST /api/series/:seriesId/chapters/:chapterId/links`

**Features:**
- Rate limiting (5/day for new users, 20/day for established)
- URL normalization and deduplication
- Domain blacklist checking
- Trust-based auto-approval (level 10+ users)
- Audit logging for Safe Harbor compliance

**Process:**
1. User submits a URL
2. System validates and normalizes URL
3. Checks blacklist and suspicious patterns
4. Determines source tier (official/aggregator/user-submitted)
5. Auto-approves or queues for moderation based on trust level

---

## What's NOT Showing (Your Specific Question)

### The Issue: MangaUpdates Release Metadata Not Displayed

For the series "The Story of the Fox Who Was Late Getting Married and Came to Be My Bride":

**MangaUpdates has this data:**
- Series ID: `31825578571`
- Title: "Totsugi Okureta Kitsune ga Yome ni Kuru Hanashi"
- Releases from various scanlation groups

**But the website doesn't show:**
- Latest chapter updates from pirate sites (by design - no direct links)
- The group name metadata showing "available on X site"

### Why This Gap Exists

The current system:

1. **Does NOT scrape pirate sites** - Only uses official APIs
2. **MangaUpdates releases need to be linked to series** - The `series_id` field in `mangaupdates_releases` needs to be populated
3. **The feed-ingest processor** handles this linking but relies on matching series

### What Should Be Shown (Per Your Request)

You want to see metadata like:
```
"Latest Chapter: 45"
"Available on: [Scanlation Group Name]"
"Last Updated: 2 days ago"
```

**Without direct links to pirate sites** - just informational metadata.

---

## Recommended Implementation

To show MangaUpdates release metadata on series pages without linking to pirate sites:

### Option 1: Display Release Groups as Metadata
```typescript
// On series page, show:
{
  latestChapter: "45",
  releaseSources: [
    { name: "Some Scans", type: "scanlation", lastUpdate: "2 days ago" },
    { name: "MANGA Plus", type: "official", url: "https://mangaplus.shueisha.co.jp/..." }
  ]
}
```

### Option 2: "Available On" Section
Show a metadata-only section:
- Official sources: Show with links
- Scanlation groups: Show name only (no link)

This maintains the legal compliance while informing users where content is available.

---

## Testing the Fox Manga

### Current Search Result
```json
{
  "id": "mangadex:2fe5571f-ecc9-4a26-9a50-cfa09757a735",
  "title": "Totsugi Okureta Kitsune ga Yome ni Kuru Hanashi",
  "source": "mangadex",
  "status": "ongoing"
}
```

### MangaUpdates Data Available
```json
{
  "series_id": 31825578571,
  "title": "Totsugi Okureta Kitsune ga Yome ni Kuru Hanashi",
  "releases": [
    { "chapter": "X", "group": "Some Scans", "date": "..." }
  ]
}
```

### Gap: The releases aren't being displayed on the series page

---

## Summary

| Feature | Status | Notes |
|---------|--------|-------|
| Official source recognition | ✅ Implemented | VIZ, MangaPlus, etc. |
| MangaDex integration | ✅ Active | Primary source |
| MangaUpdates API | ✅ Integrated | Release data available |
| AniList integration | ✅ Active | Official links |
| User link submission | ✅ Implemented | With moderation |
| **Pirate site metadata display** | ❌ Not shown | Releases exist in DB but not displayed on frontend |

The backend has the data from MangaUpdates. The missing piece is **displaying the release group metadata** on series pages without providing direct links to pirate sites.
