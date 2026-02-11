'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { prisma, withRetry } from '@/lib/prisma'
import { logger } from '@/lib/logger'

// Timeout for Supabase auth operations
const AUTH_TIMEOUT_MS = 10000

/**
 * Promise.race wrapper with timeout
 */
function withTimeout<T>(promise: Promise<T>, ms: number, operation: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${operation} timed out after ${ms}ms`)), ms)
    ),
  ])
}

// P0-4 FIX: CSRF Protection helper for server actions
// Supports ALLOWED_CSRF_ORIGINS env var and proxy x-forwarded-host header
async function validateCsrfOrigin(): Promise<void> {
  if (process.env.NODE_ENV !== 'production') {
    return; // Skip CSRF check in development
  }
  
  const headersList = await headers()
  const origin = headersList.get('origin')
  
  // No origin header = same-origin navigation (not a CSRF risk for server actions)
  if (!origin) {
    return;
  }
  
  // Determine the effective host: prefer x-forwarded-host (set by proxies/load balancers)
  const forwardedHost = headersList.get('x-forwarded-host')
  const host = forwardedHost || headersList.get('host')
  
  if (!host) {
    return; // No host to compare against
  }
  
  try {
    const originHost = new URL(origin).host
    
    // Direct match: origin matches the host header
    if (originHost === host) {
      return;
    }
    
    // Check ALLOWED_CSRF_ORIGINS env var (comma-separated list of allowed origins/hosts)
    const allowedOrigins = process.env.ALLOWED_CSRF_ORIGINS
    if (allowedOrigins) {
      const allowedList = allowedOrigins.split(',').map(o => o.trim()).filter(Boolean)
      const isAllowed = allowedList.some(allowed => {
        // Match against full origin host or partial domain suffix
        return originHost === allowed || originHost.endsWith('.' + allowed)
      })
      if (isAllowed) {
        return;
      }
    }
    
    throw new Error('Invalid request origin - CSRF protection triggered')
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes('CSRF')) {
      throw e
    }
    // URL parsing failed - invalid origin
    throw new Error('Invalid request origin format')
  }
}

// P1-7 FIX: Improved redirect error detection
function isRedirectError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  
  const error = err as { digest?: string; message?: string; name?: string }
  
  // Check all known patterns for Next.js redirect
  return (
    error.digest?.includes('NEXT_REDIRECT') ||
    error.message === 'NEXT_REDIRECT' ||
    error.name === 'RedirectError' ||
    (typeof error.digest === 'string' && error.digest.startsWith('NEXT_REDIRECT'))
  )
}

export async function login(formData: FormData): Promise<{ success?: boolean; error?: string }> {
  try {
    // P0-4: Validate CSRF
    await validateCsrfOrigin()
    
    const email = formData.get('email') as string
    const password = formData.get('password') as string

    if (!email || !password) {
      return { error: 'Email and password are required' }
    }

    let supabase
    try {
      supabase = await createClient()
    } catch (clientError) {
      logger.error('[Auth] Failed to create Supabase client:', clientError)
      return { error: 'Authentication service is temporarily unavailable. Please try again.' }
    }

    let signInData
    let signInError
    try {
      const result = await withTimeout(
        supabase.auth.signInWithPassword({ email, password }),
        AUTH_TIMEOUT_MS,
        'Sign in'
      )
      signInData = result.data
      signInError = result.error
    } catch (timeoutError) {
      logger.error('[Auth] Sign in timed out or failed:', timeoutError)
      return { error: 'Sign in is taking too long. Please check your connection and try again.' }
    }

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

    // Sync user to Prisma (non-blocking, fire-and-forget)
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
        logger.warn('[Auth] Prisma user sync failed (non-fatal):', syncErr)
      })
    }

    revalidatePath('/', 'layout')
    return { success: true }
  } catch (err: unknown) {
    if (isRedirectError(err)) {
      throw err
    }
    logger.error('[Auth] Login error:', err)
    return { error: 'An unexpected error occurred. Please try again.' }
  }
}

export async function signup(formData: FormData) {
  // P0-4: Validate CSRF
  await validateCsrfOrigin()
  
  const email = formData.get('email') as string
  const password = formData.get('password') as string
  const username = formData.get('username') as string

  if (!email || !password || !username) {
    redirect('/register?error=' + encodeURIComponent('All fields are required'))
  }

  let success = false
  let errorMessage = ''
  let needsConfirmation = false

  try {
    // Guard against Prisma client not being initialized
    if (!prisma?.user) {
        logger.error('[Auth] Prisma client not initialized')
      errorMessage = 'Service temporarily unavailable. Please try again.'
      redirect('/register?error=' + encodeURIComponent(errorMessage))
    }
    
    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [
          { email },
          { username }
        ]
      }
    })

    if (existingUser) {
      errorMessage = 'User already exists with this email or username'
    } else {
      const supabase = await createClient()
      const { data: authData, error: authError } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: { username }
        }
      })

      if (authError) {
        errorMessage = authError.message
      } else if (!authData.user) {
        errorMessage = 'Failed to create account'
      } else {
        const isConfirmed = !!authData.user.email_confirmed_at
          
          // P0 #1 FIX: Don't store password_hash — Supabase is the single source of truth for auth
          await prisma.user.upsert({
            where: { id: authData.user.id },
            update: {
              email,
              username,
            },
            create: {
              id: authData.user.id,
              email,
              username,
              password_hash: '', // Not used — Supabase handles auth
              xp: 0,
              level: 1,
              streak_days: 0,
              subscription_tier: 'free',
              notification_settings: { email: true, push: false },
              privacy_settings: { library_public: true, activity_public: true },
            }
          })
        
        if (isConfirmed) {
          success = true
        } else {
          needsConfirmation = true
        }
      }
    }
  } catch (err: unknown) {
    // P1-7 FIX: Improved redirect error detection
    if (isRedirectError(err)) {
      throw err
    }
      logger.error('[Auth] Signup error:', err)
    errorMessage = 'An unexpected error occurred during registration.'
  }

  if (success) {
    revalidatePath('/', 'layout')
    redirect('/library')
  } else if (needsConfirmation) {
    redirect('/login?message=' + encodeURIComponent('Please check your email to confirm your account before logging in.'))
  } else {
    redirect('/register?error=' + encodeURIComponent(errorMessage || 'Registration failed'))
  }
}

export async function logout() {
  try {
    const supabase = await createClient()
    await supabase.auth.signOut()
  } catch (err: unknown) {
    // P1-7 FIX: Improved redirect error detection
    if (isRedirectError(err)) {
      throw err
    }
      logger.error('[Auth] Logout error:', err)
  } finally {
    revalidatePath('/', 'layout')
    redirect('/')
  }
}
