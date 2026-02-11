# Syncing Status & NSFW Persistence Bug Fix Report

## Issues Identified

### Issue 1: "Syncing..." Status in Sidebar
**Symptoms:** User sees "(syncing...)" next to their username in the bottom left corner

**Root Cause:** The `/api/users/me` endpoint returns `_synced: false` in fallback responses when:
1. Database connection fails (transient error)
2. User exists in Supabase Auth but not yet in the Prisma database
3. Database query times out

When `_synced: false` is returned, the sidebar shows "(syncing...)" to indicate degraded state.

### Issue 2: NSFW Mode Not Persisting After Logout/Login
**Symptoms:** User sets NSFW mode, logs out, logs back in, and the mode resets to SFW

**Root Cause:** 
1. When `/api/users/me` returns a fallback response (`_synced: false`), `safe_browsing_mode` defaults to `'sfw'`
2. The `SafeBrowsingProvider` context was not handling fallback responses - it would just use whatever value came back
3. localStorage was being cleared on logout, and not used as a fallback

## Fixes Implemented

### Fix 1: Enhanced Safe Browsing Context (`src/lib/context/safe-browsing-context.tsx`)

**Changes:**
1. Added retry logic when receiving fallback responses (`_synced: false`)
   - Retries up to 2 times with exponential backoff
   - Waits 1s, then 2s between retries

2. Added localStorage caching for safe_browsing_mode
   - Caches the mode when a successful (non-fallback) response is received
   - Uses cached value as fallback when API errors occur

3. Improved error handling
   - 401 errors: Clear localStorage and force SFW (user is logged out)
   - Other errors: Use cached localStorage value if available
   - Network errors: Use cached localStorage value if available

### Fix 2: API Logging Improvements (`src/app/api/users/me/route.ts`)

**Changes:**
1. Added clearer logging prefixes `[/api/users/me]` for easier debugging
2. Added comment explaining that successful responses do NOT include `_synced` flag

## Testing Instructions

1. **Test NSFW Persistence:**
   - Log in as a user
   - Go to Settings > Safe Browsing and select NSFW
   - Refresh the page - should still show NSFW
   - Log out completely
   - Log back in - should still show NSFW

2. **Test Fallback Handling:**
   - If you see "(syncing...)" in the sidebar, check browser console for `[SafeBrowsing] Got fallback response, retrying...` messages
   - The system should automatically retry up to 2 times

3. **Test localStorage Caching:**
   - After setting NSFW mode, you can check localStorage in browser dev tools for `mangatrack_safe_browsing_mode`
   - This should persist the last known good value

## Files Modified

1. `src/lib/context/safe-browsing-context.tsx` - Added retry logic and localStorage caching
2. `src/app/api/users/me/route.ts` - Improved logging
3. `src/lib/supabase/cached-user.ts` - Fixed duplicate content issue
4. `src/lib/dns-init.ts` - Fixed duplicate content issue

## Database Verification

The user `harshitguptaagra9gm` has the correct data in the database:
- `id`: `8c56e2b0-1fb6-48c6-9952-c3bc9e75fbfc`
- `safe_browsing_mode`: `"nsfw"`
- `deleted_at`: `null` (not soft-deleted)

The user also exists in Supabase Auth with the same ID, confirming the sync is correct.

## Remaining Considerations

1. **Auth Timeouts:** If Supabase auth is timing out (3s timeout), users may see temporary issues. Consider increasing the timeout or implementing a connection pool.

2. **Database Latency:** The health check shows 188ms database latency which is acceptable but could cause intermittent issues during high load.

3. **DLQ Warning:** There are 176 unresolved failures in the Dead Letter Queue (threshold: 50). This should be investigated separately.
