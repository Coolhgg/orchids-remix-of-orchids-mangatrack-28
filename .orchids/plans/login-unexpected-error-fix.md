# Login Page "Unexpected Error" Fix Plan

## Requirements
Fix the login page that is throwing "An unexpected error occurred. Please try again." and ensure:
1. Users can successfully login with email/password
2. Session persists after login (user stays logged in)
3. Database connection issues are handled gracefully
4. No module resolution errors in middleware

## Root Cause Analysis

### Issue 1: `@supabase/ssr` Module Resolution in Edge Runtime
The middleware (`src/middleware.ts`) runs in Edge Runtime and imports `@supabase/ssr` via `src/lib/supabase/middleware.ts`. Turbopack's Edge Runtime bundler may fail to resolve the module correctly, causing the middleware to crash silently before the server action even runs.

**Evidence**: Previous logs showed `Cannot find module '@supabase/ssr'` errors. The `@supabase/ssr@0.8.0` package has native `exports` field, but stale `.next` cache may cause issues.

### Issue 2: Database "Connection closed" Errors
The `DATABASE_URL` uses PgBouncer (port 6543) which can close connections unexpectedly. The `withRetry` in `auth-actions.ts:84` wraps the Prisma upsert, but:
- No `connect_timeout` parameter in the connection string
- Connection pooling issues with PgBouncer + Prisma

**Evidence**: `[Error: Connection closed.] { digest: '1857373994' }` in terminal logs.

### Issue 3: Server Action Error Handling
In `src/app/auth/auth-actions.ts:104-106`, the outer catch block catches ALL exceptions including:
- `createClient()` failing if `cookies()` throws
- `supabase.auth.signInWithPassword()` throwing (network issues)
- Any unhandled promise rejection

This returns `"An unexpected server error occurred"` which the client displays as the generic error.

### Issue 4: No Timeout on Auth Requests
The `signInWithPassword` call has no timeout. If Supabase auth is slow or unresponsive, the request hangs indefinitely, eventually timing out at the HTTP layer with a generic error.

## Implementation Phases

### Phase 1: Clear stale cache and verify module resolution
**Files**: `next.config.ts`, `.next/` cache
**Actions**:
1. Clear `.next` directory to remove stale Turbopack cache
2. Verify `@supabase/ssr@0.8.0` exports field is intact
3. Remove any `resolveAlias` workarounds if present (native exports should work)
4. Restart dev server and verify middleware compiles without module errors

### Phase 2: Add timeout protection to auth server action
**File**: `src/app/auth/auth-actions.ts`
**Actions**:
1. Add `AUTH_TIMEOUT_MS` constant (10 seconds)
2. Create `withTimeout<T>()` helper function using `Promise.race()`
3. Wrap `supabase.auth.signInWithPassword()` call with timeout
4. Return specific error message on timeout vs generic error

```typescript
// Add at top of file
const AUTH_TIMEOUT_MS = 10000;

function withTimeout<T>(promise: Promise<T>, ms: number, operation: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => 
      setTimeout(() => reject(new Error(`${operation} timed out after ${ms}ms`)), ms)
    )
  ]);
}
```

### Phase 3: Fix database connection string
**File**: `.env`
**Actions**:
1. Add `connect_timeout=15` parameter to `DATABASE_URL`
2. Add `pool_timeout=10` parameter for PgBouncer
3. Ensure `DIRECT_URL` is used for migrations (already configured)

Updated connection string:
```
DATABASE_URL="postgresql://postgres.nkrxhoamqsawixdwehaq:hg2604207599980520@aws-1-us-east-2.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=10&connect_timeout=15&pool_timeout=10"
```

### Phase 4: Improve error handling in login action
**File**: `src/app/auth/auth-actions.ts`
**Actions**:
1. Add try-catch around `createClient()` call separately
2. Distinguish between timeout, network, and auth errors
3. Make Prisma user sync truly non-fatal (fire-and-forget with timeout)
4. Log errors with more context for debugging

### Phase 5: Verify session persistence
**File**: `src/lib/supabase/middleware.ts`
**Actions**:
1. Ensure `updateSession()` properly refreshes cookies
2. Verify `setAll()` cookie handler works in server components
3. Test that auth cookies are set with correct options (httpOnly, secure, sameSite)

### Phase 6: Test and verify complete login flow
**Actions**:
1. Navigate to `/login` - verify page loads without errors
2. Submit login form - verify server action completes within 10s
3. On success - verify redirect to `/library`
4. Refresh `/library` - verify user stays authenticated
5. Check browser cookies for `sb-*-auth-token` presence

## Detailed Code Changes

### `src/app/auth/auth-actions.ts` - Login function rewrite

```typescript
'use server'

import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { prisma, withRetry } from '@/lib/prisma'
import { logger } from '@/lib/logger'

// Timeout for auth operations
const AUTH_TIMEOUT_MS = 10000;

/**
 * Promise.race wrapper with timeout
 */
function withTimeout<T>(promise: Promise<T>, ms: number, operation: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => 
      setTimeout(() => reject(new Error(`${operation} timed out after ${ms}ms`)), ms)
    )
  ]);
}

// CSRF validation (unchanged)
async function validateCsrfOrigin(): Promise<void> {
  if (process.env.NODE_ENV !== 'production') {
    return;
  }
  
  const headersList = await headers()
  const origin = headersList.get('origin')
  const host = headersList.get('host')
  
  if (origin && host) {
    try {
      const originHost = new URL(origin).host
      if (originHost !== host) {
        throw new Error('Invalid request origin - CSRF protection triggered')
      }
    } catch (e: unknown) {
      if (e instanceof Error && e.message.includes('CSRF')) {
        throw e
      }
      throw new Error('Invalid request origin format')
    }
  }
}

export async function login(formData: FormData): Promise<{ success?: boolean; error?: string }> {
  // Validate CSRF
  await validateCsrfOrigin()
  
  const email = formData.get('email') as string
  const password = formData.get('password') as string

  if (!email || !password) {
    return { error: 'Email and password are required' }
  }

  // Step 1: Create Supabase client
  let supabase;
  try {
    supabase = await createClient()
  } catch (clientError) {
    logger.error('[Auth] Failed to create Supabase client:', clientError)
    return { error: 'Authentication service is temporarily unavailable. Please try again.' }
  }

  // Step 2: Attempt sign in with timeout protection
  let signInData;
  let signInError;
  try {
    const result = await withTimeout(
      supabase.auth.signInWithPassword({ email, password }),
      AUTH_TIMEOUT_MS,
      'Sign in'
    );
    signInData = result.data;
    signInError = result.error;
  } catch (timeoutError) {
    logger.error('[Auth] Sign in timed out:', timeoutError)
    return { error: 'Sign in is taking too long. Please check your connection and try again.' }
  }

  // Step 3: Handle auth errors
  if (signInError) {
    if (signInError.message.includes('Email not confirmed') || signInError.code === 'email_not_confirmed') {
      return { error: 'Please check your inbox and confirm your email before signing in. Check spam folder if you cannot find it.' }
    }
    if (signInError.message.includes('Invalid login credentials')) {
      return { error: 'Invalid email or password' }
    }
    logger.warn('[Auth] Sign in error:', signInError.message)
    return { error: signInError.message }
  }

  if (!signInData?.user) {
    return { error: 'Login failed - no user returned' }
  }

  // Step 4: Sync user to Prisma (non-blocking, fire-and-forget)
  // Don't let DB issues block login success
  if (prisma?.user) {
    Promise.race([
      withRetry(() => prisma.user.upsert({
        where: { id: signInData.user.id },
        update: { email },
        create: {
          id: signInData.user.id,
          email,
          username: signInData.user.user_metadata?.username || email.split('@')[0],
          password_hash: '',
          xp: 0,
          level: 1,
          subscription_tier: 'free',
        }
      }), 2, 200),
      new Promise((_, reject) => setTimeout(() => reject(new Error('DB sync timeout')), 5000))
    ]).catch((syncErr) => {
      // Non-fatal: log and continue
      logger.warn('[Auth] Prisma user sync failed (non-fatal):', syncErr)
    });
  }

  // Step 5: Success - revalidate and return
  revalidatePath('/', 'layout')
  return { success: true }
}
```

### `.env` - Database connection string update

```
DATABASE_URL="postgresql://postgres.nkrxhoamqsawixdwehaq:hg2604207599980520@aws-1-us-east-2.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=10&connect_timeout=15&pool_timeout=10"
```

### Clean restart procedure

```bash
# 1. Kill existing dev processes
pkill -f "next-server" 2>/dev/null
pkill -f "turbopack" 2>/dev/null

# 2. Clear caches
rm -rf .next .dev

# 3. Verify @supabase/ssr exports (should show "import": "./dist/module/index.js")
cat node_modules/@supabase/ssr/package.json | grep -A 5 '"exports"'

# 4. Restart dev server
bun run dev

# 5. Test login flow (once server is ready)
# Navigate to /login and attempt sign in
```

## Verification Checklist

- [ ] `bun run dev` starts without `Cannot find module '@supabase/ssr'` errors
- [ ] `/login` page loads without console errors
- [ ] Form submission completes within 10 seconds
- [ ] Valid credentials result in redirect to `/library`
- [ ] Invalid credentials show "Invalid email or password" (not "unexpected error")
- [ ] After login, refreshing `/library` keeps user authenticated
- [ ] Browser has `sb-nkrxhoamqsawixdwehaq-auth-token` cookie set
- [ ] Database connection errors are logged but don't block login

## Risk Assessment

| Change | Risk | Mitigation |
|--------|------|------------|
| Clear `.next` cache | Low | Standard dev procedure |
| Add timeout to auth | Low | Improves UX, prevents hangs |
| Update DATABASE_URL | Low | Just adds timeout params |
| Fire-and-forget DB sync | Medium | User still logged in even if DB sync fails; sync retried next request |

## Dependencies

- `@supabase/ssr@0.8.0` - already installed with native exports
- `@supabase/supabase-js@2.x` - peer dependency, already installed
- Prisma Client - already configured with retry logic

## Critical Files for Implementation

- `src/app/auth/auth-actions.ts` - Main login logic to modify
- `src/lib/supabase/server.ts` - Supabase client creation
- `src/lib/supabase/middleware.ts` - Session refresh logic
- `.env` - Database connection string
- `src/middleware.ts` - Request handling and auth check
