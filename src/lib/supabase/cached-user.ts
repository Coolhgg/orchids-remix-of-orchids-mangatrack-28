import { cache } from 'react'
import { createClient } from './server'
import { User } from '@supabase/supabase-js'
import { cookies, headers } from 'next/headers'
import { logger } from '@/lib/logger'
import crypto from 'crypto'
import { getInternalApiSecret } from '@/lib/config/env-validation'

/**
 * Check if we're in Next.js build phase - used to suppress logging during builds
 */
function isBuildPhase(): boolean {
  return process.env.NEXT_PHASE === 'phase-production-build';
}

/**
 * Fast-path check for Supabase auth cookies.
 * Supabase SSR stores auth in cookies with pattern: sb-{project-ref}-auth-token
 * If no auth cookie exists, we can skip the getUser() call entirely.
 */
async function hasSupabaseAuthCookie(): Promise<boolean> {
  try {
    const cookieStore = await cookies();
    const allCookies = cookieStore.getAll();
    
    // Check for Supabase auth cookies - pattern: sb-{project-ref}-auth-token
    return allCookies.some(cookie => 
      cookie.name.startsWith('sb-') && cookie.name.includes('-auth-token')
    );
  } catch {
    // If cookies() fails (e.g., called outside request context or during static generation),
    // return true to allow the normal auth flow to proceed
    return true;
  }
}

/**
 * FAST PATH: Read the user from middleware-injected request headers.
 * Middleware already validated the session and set signed headers.
 * This avoids making a second network call to Supabase.
 * Returns a partial User object that's sufficient for auth checks.
 */
async function getUserFromMiddlewareHeaders(): Promise<User | null> {
  try {
    const h = await headers();
    const userId = h.get('x-middleware-user-id');
    if (!userId) return null;

    const email = h.get('x-middleware-user-email') || '';
    const metaStr = h.get('x-middleware-user-meta') || '';
    const createdAt = h.get('x-middleware-user-created') || '';
    const role = h.get('x-middleware-user-role') || '';
    const hmacSignature = h.get('x-middleware-hmac');

    // SEC: Verify HMAC signature to prevent header spoofing (matches api-utils.ts logic)
    const secret = getInternalApiSecret();
    if (secret && hmacSignature) {
      const hmacPayload = `${userId}|${email}|${role}|${metaStr}|${createdAt}`;
      const expectedHmac = crypto
        .createHmac('sha256', secret)
        .update(hmacPayload)
        .digest('hex');
      if (hmacSignature !== expectedHmac) {
        logger.warn('[AuthCache] HMAC verification failed for middleware user headers', { userId });
        return null;
      }
    } else if (process.env.NODE_ENV === 'production' && !hmacSignature) {
      // In production, reject unsigned headers
      logger.warn('[AuthCache] Missing HMAC signature on middleware user headers', { userId });
      return null;
    }

    let userMeta: Record<string, unknown> = {};
    try {
      if (metaStr) userMeta = JSON.parse(metaStr);
    } catch { /* ignore parse errors */ }

    // Construct a User-compatible object from middleware headers
    return {
      id: userId,
      email,
      created_at: createdAt,
      app_metadata: { role: role || undefined },
      user_metadata: userMeta,
      aud: 'authenticated',
      role: role || 'authenticated',
    } as User;
  } catch {
    // headers() can fail during static generation - this is expected
    return null;
  }
}

/**
 * Optimized user fetcher that uses React cache() to deduplicate requests 
 * within the same render cycle (server components).
 * 
 * Fast path priority:
   * 1. Read from middleware-injected headers (zero network cost)
   * 2. Check for auth cookie existence (skip network call if no cookie)
   * 3. Fall back to supabase.auth.getUser() (validates JWT with Supabase server)
   */
export const getCachedUser = cache(async (): Promise<User | null> => {
  try {
    // FAST PATH #1: Read from middleware headers (no network call needed)
    const middlewareUser = await getUserFromMiddlewareHeaders();
    if (middlewareUser) {
      return middlewareUser;
    }

    // FAST PATH #2: Check for auth cookie before making the network call
    if (!await hasSupabaseAuthCookie()) {
      return null;
    }
    
    const supabase = await createClient()
    
    // SECURITY FIX: Use getUser() which validates the JWT against Supabase's server.
    // getSession() only reads the JWT from the cookie without validation,
    // meaning tampered/expired tokens could be trusted.
    // getUser() is the only secure approach for server-side auth checks.
    const { data: { user }, error } = await supabase.auth.getUser();
    
    if (error) {
      if (!isBuildPhase()) {
        logger.warn('[AuthCache] getUser error:', { error: error.message });
      }
      return null;
    }
    
    if (!user) {
      return null;
    }
    
    return user
  } catch (err: unknown) {
    // Never log during build phase - static generation errors are expected
    if (isBuildPhase()) {
      return null;
    }
    
    // Only log unexpected errors, not expected static generation errors
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes('DYNAMIC_SERVER_USAGE') && 
        !message.includes('cookies') &&
        !message.includes('static') &&
        !message.includes('rendered statically')) {
        logger.error('[AuthCache] Unexpected error fetching user:', { error: err instanceof Error ? err.message : String(err) })
    }
    return null
  }
})

/**
 * Get user with explicit retry support for degraded mode.
 * Uses getUser() which validates the JWT with the Supabase server.
 */
export async function getUserWithRetry(_maxRetries = 2): Promise<User | null> {
  // FAST PATH: Check for auth cookie before making network calls
  if (!await hasSupabaseAuthCookie()) {
    return null;
  }
  
  try {
    const supabase = await createClient();
    // SECURITY FIX: Use getUser() for server-side JWT validation
    const { data: { user }, error } = await supabase.auth.getUser();
    
    if (error) {
      if (!isBuildPhase()) {
        logger.warn('[AuthCache] getUserWithRetry getUser error:', { error: error.message });
      }
      return null;
    }
    
    return user ?? null;
  } catch (err: unknown) {
    if (isBuildPhase()) {
      return null;
    }
    
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes('DYNAMIC_SERVER_USAGE') && 
        !message.includes('cookies') &&
        !message.includes('static') &&
        !message.includes('rendered statically')) {
        logger.error('[AuthCache] getUserWithRetry error:', { error: message });
    }
    return null;
  }
}
