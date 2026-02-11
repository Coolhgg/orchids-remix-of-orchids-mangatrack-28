# Fix: Login State Not Persisting After Successful Authentication

## Requirements

User is unable to stay logged in even after successful login - the UI does not reflect the logged-in state. This is caused by multiple issues in the auth flow where:

1. `getCachedUser()` in server components has a 3-second timeout that's too short
2. The homepage (`page.tsx`) makes a second auth check via `getCachedUser()` instead of trusting the middleware headers
3. When `getCachedUser()` times out, user is treated as logged out and shown the landing page
4. The client-side Header component independently fetches auth state via `supabase.auth.getUser()` which can also timeout

## Root Cause Analysis

### Issue 1: Double Authentication Calls

The middleware already validates the user and injects signed headers (`x-middleware-user-id`, `x-middleware-user-email`, etc.). However:

- **Middleware**: Calls `supabase.auth.getUser()` with 5s timeout
- **Server Components**: Call `getCachedUser()` which makes another `supabase.auth.getUser()` with 3s timeout
- **Client Components**: Header calls `supabase.auth.getUser()` again

This results in 2-3 redundant auth calls per page load.

### Issue 2: getCachedUser Not Using Middleware Headers

The `getCachedUser()` function in `src/lib/supabase/cached-user.ts` does NOT read the `x-middleware-user-*` headers that middleware already computed. It always makes a fresh network call to Supabase.

### Issue 3: Short Timeout in getCachedUser

The 3-second timeout in `getCachedUser()` is too aggressive. When Supabase is slow (due to token refresh, cold start, or network latency), the timeout hits and returns `null`, causing the user to appear logged out.

### Issue 4: Homepage Redirect Logic

In `src/app/page.tsx`:
```typescript
const user = await getCachedUser()  // Can timeout and return null
if (user) {
  redirect('/library')  // Never reached if getCachedUser times out
}
return <ScrollytellingLanding />  // Shows landing page to logged-in users
```

## Solution Design

### Phase 1: Update getCachedUser to Read Middleware Headers (PRIMARY FIX)

Modify `src/lib/supabase/cached-user.ts` to first check for middleware-injected headers before making a network call:

```typescript
export const getCachedUser = cache(async (): Promise<User | null> => {
  try {
    // FAST PATH: Check for middleware headers first
    const user = await getMiddlewareUserFromHeaders();
    if (user) {
      return user;  // Trust middleware, skip network call
    }
    
    // SLOW PATH: Fall back to Supabase call if no headers
    // (This path is for static pages without middleware)
    // ... existing code ...
  }
})
```

### Phase 2: Increase Timeouts

- **getCachedUser timeout**: Increase from 3s to 7s
- **Middleware timeout**: Keep at 5s (already reasonable)

### Phase 3: Add Graceful Degradation Mode

When `getCachedUser` times out on protected routes, instead of treating user as logged out:
1. Check for the presence of auth cookies
2. If cookies exist, allow access in "degraded mode" (show UI but with stale data)
3. Let client-side hydration recover the session

## Implementation Phases

### Phase 1: Optimize getCachedUser to Use Middleware Headers
- Modify `src/lib/supabase/cached-user.ts` to import and use `getMiddlewareUser` from `src/lib/api-utils.ts`
- Add a new function `getMiddlewareUserAsSupabaseUser()` that converts middleware user format to Supabase User type
- Update `getCachedUser` to try middleware headers first
- Maintain backward compatibility for static pages

### Phase 2: Increase Timeout in getCachedUser
- Change `CACHED_USER_TIMEOUT_MS` from 3000 to 7000 in `src/lib/supabase/cached-user.ts`

### Phase 3: Update Header Component for Client-Side Resilience
- Modify `src/components/sections/Header.tsx` to show loading state longer
- Add retry logic when initial auth check fails
- Trust cookie presence as a signal for authentication

### Phase 4: Add Cookie-Based Fast Path in Server Components
- Modify homepage and dashboard layout to check for auth cookie presence before calling getCachedUser
- If auth cookie exists but getCachedUser times out, show a loading/skeleton state instead of logged-out state

## Testing Strategy

1. **Simulate slow Supabase**: Add artificial delay in middleware to verify timeout handling
2. **Verify cookie flow**: Ensure cookies are properly set after login and persisted across requests
3. **Check header propagation**: Verify `x-middleware-user-*` headers reach server components
4. **Test circuit breaker**: Ensure circuit breaker doesn't open prematurely with new timeouts

## Critical Files for Implementation

- `src/lib/supabase/cached-user.ts` - Core fix: add middleware header support
- `src/lib/supabase/middleware.ts` - Verify timeout and header injection
- `src/app/page.tsx` - Update redirect logic with fallback
- `src/app/(dashboard)/layout.tsx` - Update auth check with fallback
- `src/components/sections/Header.tsx` - Client-side auth state handling
