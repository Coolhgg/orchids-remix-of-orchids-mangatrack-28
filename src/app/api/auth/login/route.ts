import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { getSupabaseUrl, getSupabaseAnonKey } from '@/lib/env'
import { prisma, withRetry } from '@/lib/prisma'
import { logger } from '@/lib/logger'
import { getClientIp, checkAuthRateLimit, getRateLimitInfo } from '@/lib/api-utils'

export async function POST(request: NextRequest) {
  try {
    // Parse JSON body safely
    let body: Record<string, unknown>
    try {
      body = await request.json()
    } catch {
      return NextResponse.json(
        { error: 'Invalid request body' },
        { status: 400 }
      )
    }

    const { email, password } = body as { email?: string; password?: string }

    if (!email || !password) {
      return NextResponse.json(
        { error: 'Email and password are required' },
        { status: 400 }
      )
    }

    const ip = getClientIp(request)

    // Server-side rate limiting: 5 attempts per minute per IP
    const rateLimitAllowed = await checkAuthRateLimit(ip)
    if (!rateLimitAllowed) {
      return NextResponse.json(
        { error: 'Too many login attempts. Please wait a moment and try again.' },
        { status: 429, headers: { 'Retry-After': '60' } }
      )
    }

    // Server-side lockout check: block if too many recent failures
    if (prisma?.$queryRaw) {
      try {
        const recentFailures = await prisma.$queryRaw<{ count: number }[]>`
          SELECT COUNT(*)::int as count
          FROM login_attempts
          WHERE (email = ${email} OR ip_address = ${ip})
          AND success = false
          AND attempted_at > now() - interval '15 minutes'
        `
        const failCount = recentFailures[0]?.count || 0
        if (failCount >= 5) {
          return NextResponse.json(
            { error: 'Account temporarily locked due to too many failed attempts. Please try again in 15 minutes.' },
            { status: 429, headers: { 'Retry-After': '900' } }
          )
        }
      } catch (lockoutErr) {
        // Non-fatal: proceed with login if lockout check fails
        logger.warn('[Auth API] Lockout check failed (non-fatal):', lockoutErr)
      }
    }

    // Create Supabase client with cookie handling for Route Handler
    const cookieStore = await cookies()
    const supabase = createServerClient(
      getSupabaseUrl(),
      getSupabaseAnonKey(),
      {
        cookies: {
          getAll() {
            return cookieStore.getAll()
          },
          setAll(cookiesToSet) {
            try {
              cookiesToSet.forEach(({ name, value, options }) =>
                cookieStore.set(name, value, options)
              )
            } catch {
              // Ignore cookie setting errors in route handlers
            }
          },
        },
      }
    )

    // Attempt sign in
    const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    })

    if (signInError) {
      // Record failed attempt with timeout to avoid blocking the response
        if (prisma?.$executeRaw) {
          try {
            await Promise.race([
              prisma.$executeRaw`
                INSERT INTO login_attempts (email, ip_address, success)
                VALUES (${email}, ${ip}, false)
              `,
              new Promise((_, reject) => setTimeout(() => reject(new Error('Login attempt recording timed out')), 3000))
            ]);
          } catch (err: unknown) {
            logger.warn('[Auth API] Failed to record login attempt:', { error: err instanceof Error ? err.message : String(err) });
          }
        }

      if (signInError.message.includes('Email not confirmed') || signInError.code === 'email_not_confirmed') {
        return NextResponse.json(
          { error: 'Please check your inbox and confirm your email before signing in. Check spam folder if you cannot find it.' },
          { status: 401 }
        )
      }
      if (signInError.message.includes('Invalid login credentials')) {
        return NextResponse.json(
          { error: 'Invalid email or password' },
          { status: 401 }
        )
      }
      logger.warn('[Auth API] Sign in error:', signInError.message)
      // Sanitize: don't leak raw Supabase error details to client
      return NextResponse.json(
        { error: 'Authentication failed. Please try again.' },
        { status: 401 }
      )
    }

    if (!signInData?.user) {
      return NextResponse.json(
        { error: 'Login failed - no user returned' },
        { status: 500 }
      )
    }

    // Sync user to Prisma (fire-and-forget)
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
        logger.warn('[Auth API] Prisma user sync failed (non-fatal):', syncErr)
      })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    logger.error('[Auth API] Login error:', error)
    return NextResponse.json(
      { error: 'An unexpected error occurred. Please try again.' },
      { status: 500 }
    )
  }
}
