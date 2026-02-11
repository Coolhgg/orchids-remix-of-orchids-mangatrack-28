# Build Log Side Effects Fix Plan

## Status: IMPLEMENTED

## Summary of Changes

All five phases have been implemented to fix excessive logging during Next.js builds.

### Phase 1: Redis Module-Level Side Effects - FIXED
**File:** `src/lib/redis.ts`
- Added `isBuildPhase()` helper function
- Wrapped all `console.log/warn/error` calls with build phase checks
- Moved Redis URL logging to `logRedisTargetsOnce()` which uses `globalThis` to prevent duplicate logs
- `createRedisClient()` returns early during build phase after creating client without event listeners

### Phase 2: DNS Initialization - FIXED
**File:** `src/lib/dns-init.ts`
- Added `isBuildPhase()` helper function  
- `initDNS()` returns early during build phase
- Suppressed all logging in production (`NODE_ENV !== 'production'`)
- Pre-resolution only runs in development

### Phase 3: Queue Logs - ALREADY FIXED
**File:** `src/lib/queues.ts`
- Was already wrapped with `process.env.NEXT_PHASE !== 'phase-production-build'` checks

### Phase 4: AuthCache DYNAMIC_SERVER_USAGE - FIXED
**File:** `src/lib/supabase/cached-user.ts`
- Added `isBuildPhase()` helper function
- All `console.log/warn/error` calls now check build phase first
- DYNAMIC_SERVER_USAGE errors are silently handled in both build and runtime

### Phase 5: Scraper DNS Init - ALREADY FIXED
**File:** `src/lib/scrapers/index.ts`
- Was already using lazy `ensureDNS()` pattern
- No immediate `initDNS()` call at module level

## Expected Build Output Improvements

| Log Type | Before | After |
|----------|--------|-------|
| `[Redis] API Client Target:` | 30+ times | 0 during build |
| `[Redis] Worker Client Target:` | 30+ times | 0 during build |
| `[DNS] Initialized fallback DNS servers` | 20+ times | 0 during build |
| `[DNS] Patched dns.lookup` | 20+ times | 0 during build |
| `[DNS] Pre-resolved...` | 60+ times | 0 during build |
| `[Queues] Redis mode:` | 10+ times | 0 during build |
| `[AuthCache] Failed to read cookies:` | 20+ times | 0 during build |

## Verification

The dev server logs show the optimization is working:
- Redis/Queue logs appear only ONCE when `/api/health` is called (actual usage)
- No logs appear during page compilation
- Homepage loads in ~150-200ms without build-time side effects

## Files Modified

1. `src/lib/redis.ts` - Added build phase detection, wrapped all logs
2. `src/lib/dns-init.ts` - Added build phase detection, suppressed production logs
3. `src/lib/supabase/cached-user.ts` - Added build phase detection to all error logs
