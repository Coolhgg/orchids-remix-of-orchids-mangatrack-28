import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import type { User } from '@supabase/supabase-js'
import { 
  canMakeAuthRequest, 
  recordAuthSuccess, 
  recordAuthFailure,
  getCircuitState 
} from '@/lib/auth-circuit-breaker'
import { logger } from '@/lib/logger'

// P0-2 FIX: Return user from updateSession to avoid double auth call
export interface UpdateSessionResult {
  response: NextResponse
  user: User | null
}

// FIX #10: Extract duplicated path arrays into shared constants
const PUBLIC_PAGE_PATHS = [
  '/login',
  '/register',
  '/forgot-password',
  '/reset-password',
  '/auth',
  '/onboarding',
  '/browse',
  '/series',
  '/dmca',
] as const;

const PUBLIC_API_PATHS = [
  '/api/health',
  '/api/auth/login',
  '/api/auth/check-username',
  '/api/auth/lockout',
  '/api/proxy/image',
  '/api/proxy/check-url',
  '/api/series/', // Series info and chapters should be viewable without auth
  '/api/dmca',
] as const;

function isPublicPagePath(pathname: string): boolean {
  return PUBLIC_PAGE_PATHS.some(path => pathname.startsWith(path));
}

function isPublicApiPath(pathname: string): boolean {
  return PUBLIC_API_PATHS.some(path => pathname.startsWith(path));
}

/**
 * Fast-path check for Supabase auth cookies.
 * Supabase stores auth in cookies named: sb-{project-ref}-auth-token
 * If no auth cookie exists, we can skip the getUser() call entirely,
 * which prevents the 3-5 second timeout on unauthenticated requests.
 */
function hasSupabaseAuthCookie(request: NextRequest): boolean {
  const cookies = request.cookies.getAll();
  // Match any cookie starting with "sb-" and containing "-auth-token"
  return cookies.some(cookie => 
    cookie.name.startsWith('sb-') && cookie.name.includes('-auth-token')
  );
}

export async function updateSession(request: NextRequest): Promise<UpdateSessionResult> {
  let supabaseResponse = NextResponse.next({
    request,
  })

  const pathname = request.nextUrl.pathname;
  const isApiPath = pathname.startsWith('/api');

  // FAST PATH: If no auth cookie exists, skip the getUser() call entirely.
  // This prevents 3-5 second timeouts for unauthenticated users.
  const hasAuthCookie = hasSupabaseAuthCookie(request);
  if (!hasAuthCookie) {
    // No auth cookie = definitely no session
    // Return early for public paths, or handle protected paths below
    
    // For public paths and homepage, just pass through with no user
    if (isPublicPagePath(pathname) || pathname === '/' || isPublicApiPath(pathname)) {
      return { response: supabaseResponse, user: null };
    }
    
    // For protected API routes, return 401
      if (isApiPath) {
        const requestId = (typeof crypto !== 'undefined' && crypto.randomUUID)
          ? crypto.randomUUID().split('-')[0].toUpperCase()
          : Math.random().toString(36).substring(2, 10).toUpperCase();
        return {
          response: new NextResponse(
            JSON.stringify({ error: { message: 'Unauthorized', code: 'UNAUTHORIZED', requestId } }),
            { status: 401, headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId } }
          ),
          user: null
        };
      }
      
      // For protected pages, redirect to login
      const url = request.nextUrl.clone();
      url.pathname = '/login';
      return { response: NextResponse.redirect(url), user: null };
    }

  // Check circuit breaker before making auth call
  const circuitState = getCircuitState();
  if (!canMakeAuthRequest()) {
    logger.warn(`[Supabase] Auth circuit breaker OPEN - skipping auth call`, { state: circuitState.state });
    
    if (isApiPath) {
      return {
        response: new NextResponse(
          JSON.stringify({ 
            error: 'service_unavailable',
            reason: 'auth_circuit_open',
            retry: true,
            retry_after: 60
          }),
          { 
            status: 503, 
            headers: { 
              'Content-Type': 'application/json',
              'Retry-After': '60',
              'x-auth-degraded': 'circuit_open'
            }
          }
        ),
        user: null
      };
    }
    
    if (!isPublicPagePath(pathname) && pathname !== '/') {
      const url = request.nextUrl.clone();
      url.pathname = '/login';
      url.searchParams.set('reason', 'auth_circuit_open');
      return {
        response: NextResponse.redirect(url),
        user: null
      };
    }
    
    return { response: supabaseResponse, user: null };
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return request.cookies.getAll()
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
            supabaseResponse = NextResponse.next({
              request,
            })
            cookiesToSet.forEach(({ name, value, options }) =>
              supabaseResponse.cookies.set(name, value, options)
            )
          },
        },
      }
  )

  // PRIMARY: Use getUser() which validates the JWT against Supabase's server.
  // getSession() only reads the JWT from the cookie without validation,
  // which is insecure for server-side auth checks.
  let user: User | null = null;
  try {
    const { data: { user: authUser }, error: authError } = await supabase.auth.getUser();
    if (authError) {
      logger.warn('[Supabase] getUser error:', { error: authError.message });
    }
    if (authUser) {
      user = authUser;
      recordAuthSuccess();
    }
  } catch (err: unknown) {
    logger.error('[Supabase] Auth error:', { error: err instanceof Error ? err.message : String(err) });
    recordAuthFailure();
  }

    if (!user) {
      // For protected API routes, return 401 JSON response
      if (isApiPath && !isPublicApiPath(pathname)) {
        const requestId = (typeof crypto !== 'undefined' && crypto.randomUUID)
          ? crypto.randomUUID().split('-')[0].toUpperCase()
          : Math.random().toString(36).substring(2, 10).toUpperCase();
        return {
          response: new NextResponse(
            JSON.stringify({ error: { message: 'Unauthorized', code: 'UNAUTHORIZED', requestId } }),
            { status: 401, headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId } }
          ),
          user: null
        }
      }

    // For protected pages, redirect to login
    if (!isPublicPagePath(pathname) && !isPublicApiPath(pathname) && pathname !== '/') {
      const url = request.nextUrl.clone()
      url.pathname = '/login'
      return {
        response: NextResponse.redirect(url),
        user: null
      }
    }
  }

  return {
    response: supabaseResponse,
    user
  }
}
