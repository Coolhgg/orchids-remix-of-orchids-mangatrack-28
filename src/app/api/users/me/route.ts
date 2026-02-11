import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase/admin"
import { prisma, withRetry, isTransientError, DEFAULT_TX_OPTIONS } from "@/lib/prisma"
import { checkRateLimit, handleApiError, ApiError, ErrorCodes, sanitizeInput, sanitizeText, validateOrigin, USERNAME_REGEX, getClientIp, logSecurityEvent, validateContentType, getMiddlewareUser } from "@/lib/api-utils"
import { logger } from "@/lib/logger"
import { z } from "zod"
import { sanitizePrismaObject } from "@/lib/utils"

const UpdateProfileSchema = z.object({
  username: z.string().min(3).max(20).regex(USERNAME_REGEX, "Username can only contain letters, numbers, underscores, and hyphens").optional(),
  bio: z.string().max(500).optional(),
  avatar_url: z.string().url().optional().or(z.literal("")),
  notification_settings: z.object({
    email_new_chapters: z.boolean().optional(),
    email_follows: z.boolean().optional(),
    email_achievements: z.boolean().optional(),
    push_enabled: z.boolean().optional(),
  }).optional(),
  privacy_settings: z.object({
    library_public: z.boolean().optional(),
    activity_public: z.boolean().optional(),
    followers_public: z.boolean().optional(),
    following_public: z.boolean().optional(),
    profile_searchable: z.boolean().optional(),
  }).optional(),
  safe_browsing_mode: z.enum(['sfw', 'sfw_plus', 'nsfw']).optional(),
    safe_browsing_indicator: z.enum(['toggle', 'icon', 'hidden']).optional(),
    default_source: z.string().max(50).optional().nullable(),
    notification_digest: z.enum(['immediate', 'short', 'hourly', 'daily']).optional(),
  })

const USER_SELECT_FIELDS = {
  id: true,
  email: true,
  username: true,
  avatar_url: true,
  bio: true,
  xp: true,
  level: true,
  streak_days: true,
  longest_streak: true,
  chapters_read: true,
  created_at: true,
  updated_at: true,
  privacy_settings: true,
  notification_settings: true,
  safe_browsing_mode: true,
  safe_browsing_indicator: true,
  default_source: true,
  notification_digest: true,
  _count: {
    select: {
      libraryEntries: true,
      follows_follows_follower_idTousers: true,
      follows_follows_following_idTousers: true,
    },
  },
} as const

export async function GET(request: NextRequest) {
  const timings: Record<string, number> = {};
  const startTotal = Date.now();
  
  try {
    // Rate limit: 60 requests per minute per IP
    const startRateLimit = Date.now();
    const ip = getClientIp(request)
    if (!await checkRateLimit(`users-me:${ip}`, 60, 60000)) {
      throw new ApiError('Too many requests. Please wait a moment.', 429, ErrorCodes.RATE_LIMITED)
    }
    timings.rateLimit = Date.now() - startRateLimit;

    const startAuth = Date.now();
    const user = await getMiddlewareUser()
    timings.auth = Date.now() - startAuth;

    if (!user) {
      throw new ApiError("Unauthorized", 401, ErrorCodes.UNAUTHORIZED)
    }

    // Generate fallback username from Supabase data
    const fallbackUsername = user.user_metadata?.username || 
                            user.email?.split('@')[0]?.replace(/[^a-z0-9_]/gi, '').toLowerCase() || 
                            `user_${user.id.slice(0, 8)}`

    // Create fallback response for when DB is unavailable
    const createFallbackResponse = (warning: string) => ({
      id: user.id,
      email: user.email,
      username: fallbackUsername,
      avatar_url: user.user_metadata?.avatar_url || null,
      bio: null,
      xp: 0,
      level: 1,
      streak_days: 0,
      longest_streak: 0,
      chapters_read: 0,
      library_count: 0,
      followers_count: 0,
      following_count: 0,
      safe_browsing_mode: 'sfw',
      safe_browsing_indicator: 'toggle',
      default_source: null,
      _synced: false,
      _warning: warning
    })

    // Try to get user from database with retry logic
    let dbUser = null
    const startDb = Date.now();
    try {
      dbUser = await withRetry(
          () => prisma.user.findUnique({
            where: { id: user.id },
            select: USER_SELECT_FIELDS,
          }),
          3,  // 3 retries
          150 // 150ms base delay
        )
      timings.database = Date.now() - startDb;
      
      // ALWAYS log timing for debugging
        logger.debug("[/api/users/me] Query completed:", { 
        latencyMs: timings.database, 
        userId: user.id.slice(0, 8),
        found: !!dbUser,
        authLatency: timings.auth
      })
    } catch (dbError: unknown) {
      timings.database = Date.now() - startDb;
      timings.total = Date.now() - startTotal;
      
      const errMsg = dbError instanceof Error ? dbError.message?.slice(0, 300) : String(dbError)
      const errCode = (dbError as { code?: string })?.code
      const errName = dbError instanceof Error ? dbError.name : undefined
      
      // DETAILED ERROR LOGGING for debugging
        logger.error("[/api/users/me] DATABASE ERROR:", {
        message: errMsg,
        code: errCode,
        name: errName,
        isTransient: isTransientError(dbError),
        userId: user.id.slice(0, 8) + '...',
        timings
      })
      
      // If it's a transient database error, return a degraded response with Supabase data
      if (isTransientError(dbError)) {
        return NextResponse.json(createFallbackResponse("Could not connect to database. Some data may be unavailable."))
      }
      throw dbError
    }

    // AUTO-SYNC: If user exists in Supabase but not in Prisma, create them
    if (!dbUser) {
        logger.info("[/api/users/me] User exists in Supabase but not Prisma, auto-creating:", { userId: user.id })
      
      // Generate a unique username
      let username = fallbackUsername.slice(0, 20)
      
      try {
        // BUG-G FIX: Use a single findMany query to find all colliding usernames,
        // then pick the first available suffix — avoids up to 1000 sequential queries.
        const baseSlice = fallbackUsername.slice(0, 16)
        const existingUsers = await withRetry(() => prisma.user.findMany({
          where: {
            username: {
              startsWith: baseSlice,
              mode: 'insensitive',
            },
          },
          select: { username: true },
        }))
        const takenUsernames = new Set(existingUsers.map(u => u.username.toLowerCase()))
        
        if (takenUsernames.has(username.toLowerCase())) {
          let found = false
          for (let suffix = 1; suffix <= 999; suffix++) {
            const candidate = `${baseSlice}${suffix}`
            if (!takenUsernames.has(candidate.toLowerCase())) {
              username = candidate
              found = true
              break
            }
          }
          if (!found) {
            username = `user_${Date.now().toString(36)}`
          }
        }
        
        // FIX: Use upsert to handle race conditions where another request creates the user
        // between our findUnique and create calls. This is atomic and idempotent.
        dbUser = await withRetry(
          () => prisma.user.upsert({
            where: { id: user.id },
            update: {
              // Only update fields that should be synced from Supabase
              // Don't overwrite existing user data like xp, level, etc.
              email: user.email!,
              // Optionally sync avatar if the user doesn't have one set
            },
            create: {
              id: user.id,
              email: user.email!,
              username,
              password_hash: '', // OAuth users don't have a password
              xp: 0,
              level: 1,
              streak_days: 0,
              longest_streak: 0,
              chapters_read: 0,
              subscription_tier: 'free',
              notification_settings: {
                email_new_chapters: true,
                email_follows: true,
                email_achievements: true,
                push_enabled: false,
              },
              privacy_settings: { library_public: true, activity_public: true },
              safe_browsing_mode: 'sfw',
              safe_browsing_indicator: 'toggle',
              avatar_url: user.user_metadata?.avatar_url || null,
            },
            select: USER_SELECT_FIELDS,
          }),
          2,
          300
        )
      } catch (createError: unknown) {
        // Handle any remaining edge cases
        const errCode = (createError as { code?: string })?.code
        if (errCode === 'P2002') {
          // Username collision on create - try to fetch the existing user
          dbUser = await withRetry(
            () => prisma.user.findUnique({
              where: { id: user.id },
              select: USER_SELECT_FIELDS,
            }),
            2,
            200
          )
        } else if (isTransientError(createError)) {
          // Database is unavailable, return Supabase data
          return NextResponse.json(createFallbackResponse("Account created but database sync pending. Some features may be limited."))
        } else {
          throw createError
        }
      }
    }

    if (!dbUser) {
      // Fallback: Return Supabase data if no DB user
      return NextResponse.json(createFallbackResponse("User profile not found in database."))
    }

    timings.total = Date.now() - startTotal;
    
    // Log timing if slow (> 500ms)
    if (timings.total > 500) {
        logger.warn("[/api/users/me] SLOW REQUEST:", { timings });
    }

    // SUCCESS: Return the full user data from database (no _synced flag = fully synced)
    return NextResponse.json(sanitizePrismaObject({
      id: dbUser.id,
      email: dbUser.email,
      username: dbUser.username,
      avatar_url: dbUser.avatar_url,
      bio: dbUser.bio,
      xp: dbUser.xp,
      level: dbUser.level,
      streak_days: dbUser.streak_days,
      longest_streak: dbUser.longest_streak,
      chapters_read: dbUser.chapters_read,
      created_at: dbUser.created_at,
      updated_at: dbUser.updated_at,
      privacy_settings: dbUser.privacy_settings,
      notification_settings: dbUser.notification_settings,
      safe_browsing_mode: dbUser.safe_browsing_mode,
      safe_browsing_indicator: dbUser.safe_browsing_indicator,
      default_source: dbUser.default_source,
      notification_digest: dbUser.notification_digest,
      library_count: dbUser._count?.libraryEntries || 0,
        followers_count: dbUser._count?.follows_follows_follower_idTousers || 0,
        following_count: dbUser._count?.follows_follows_following_idTousers || 0,
    }))
  } catch (error: unknown) {
    return handleApiError(error)
  }
}

export async function PATCH(request: NextRequest) {
    try {
      // CSRF Protection
      validateOrigin(request)

      // Content-Type validation
      validateContentType(request)

      // Rate limit: 20 profile updates per minute per IP

    const ip = getClientIp(request)
    if (!await checkRateLimit(`users-me-update:${ip}`, 20, 60000)) {
      throw new ApiError('Too many requests. Please wait a moment.', 429, ErrorCodes.RATE_LIMITED)
    }

    const user = await getMiddlewareUser()

    if (!user) {
      throw new ApiError("Unauthorized", 401, ErrorCodes.UNAUTHORIZED)
    }

    let body
    try {
      body = await request.json()
    } catch {
      throw new ApiError("Invalid JSON body", 400, ErrorCodes.BAD_REQUEST)
    }
    
    const validatedBody = UpdateProfileSchema.safeParse(body)
    if (!validatedBody.success) {
      throw new ApiError(validatedBody.error.errors[0].message, 400, ErrorCodes.VALIDATION_ERROR)
    }

    const { username, bio, avatar_url, notification_settings, privacy_settings, safe_browsing_mode, safe_browsing_indicator, default_source, notification_digest } = validatedBody.data

    const updateData: Record<string, unknown> = {}
    if (username !== undefined) updateData.username = sanitizeInput(username.toLowerCase(), 20)
    if (bio !== undefined) updateData.bio = sanitizeInput(bio, 500)
    if (avatar_url !== undefined) updateData.avatar_url = avatar_url
    if (safe_browsing_mode !== undefined) updateData.safe_browsing_mode = safe_browsing_mode
    if (safe_browsing_indicator !== undefined) updateData.safe_browsing_indicator = safe_browsing_indicator
    if (default_source !== undefined) updateData.default_source = default_source
    if (notification_digest !== undefined) updateData.notification_digest = notification_digest

    // For JSON settings, merge with existing values to avoid overwriting unset fields
    const needsSettingsMerge = notification_settings !== undefined || privacy_settings !== undefined
    let existingUser: { notification_settings: unknown; privacy_settings: unknown } | null = null
    if (needsSettingsMerge) {
      existingUser = await prisma.user.findUnique({
        where: { id: user.id },
        select: { notification_settings: true, privacy_settings: true },
      })
    }

    if (notification_settings !== undefined) {
      const existing = (existingUser?.notification_settings as Record<string, unknown>) || {}
      updateData.notification_settings = { ...existing, ...notification_settings }
    }
    if (privacy_settings !== undefined) {
      const existing = (existingUser?.privacy_settings as Record<string, unknown>) || {}
      updateData.privacy_settings = { ...existing, ...privacy_settings }
    }

    // FIX BUG-001: Use advisory lock to prevent race conditions on username updates
      const updatedUser = await withRetry(
        async () => {
          return prisma.$transaction(async (tx) => {
            // If username is being changed, acquire advisory lock to prevent race conditions
            if (username !== undefined) {
              // Acquire a transaction-scoped advisory lock based on the lowercase username hash
              // This ensures only one transaction can claim a specific username at a time
              await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${username.toLowerCase()}))`
              
              const existing = await tx.user.findFirst({
                where: { 
                  username: { equals: username, mode: 'insensitive' },
                  id: { not: user.id },
                },
              })
              
              if (existing) {
                throw new ApiError("Username is already taken", 409, ErrorCodes.CONFLICT)
              }
            }
            
            const result = await tx.user.update({
              where: { id: user.id },
              data: updateData,
              select: {
                id: true,
                email: true,
                username: true,
                avatar_url: true,
                bio: true,
                xp: true,
                level: true,
                notification_settings: true,
                privacy_settings: true,
                safe_browsing_mode: true,
                safe_browsing_indicator: true,
                default_source: true,
                notification_digest: true,
              },
            })

            // BUG 51: Audit Log for critical settings changes
            const criticalFields = ['safe_browsing_mode', 'privacy_settings', 'username', 'notification_settings', 'default_source', 'notification_digest']
            const changedFields = Object.keys(updateData).filter(key => criticalFields.includes(key))
            
            if (changedFields.length > 0) {
              await logSecurityEvent({
                userId: user.id,
                event: 'user.update_settings',
                status: 'success',
                ipAddress: ip,
                userAgent: request.headers.get('user-agent'),
                metadata: {
                  changed_fields: changedFields,
                  updates: Object.fromEntries(
                    Object.entries(updateData).filter(([k]) => criticalFields.includes(k))
                  )
                }
              })
            }

            return result
          }, DEFAULT_TX_OPTIONS)
        },
        2,
        200
      )

    return NextResponse.json(updatedUser)
  } catch (error: unknown) {
    // Handle unique constraint violation (race condition fallback)
    if (error instanceof Error && 'code' in error && (error as any).code === 'P2002' && (error as any).meta?.target?.includes('username')) {
      return handleApiError(new ApiError("Username is already taken", 409, ErrorCodes.CONFLICT))
    }
    return handleApiError(error)
  }
}

export async function DELETE(request: NextRequest) {
  try {
    // CSRF Protection
    validateOrigin(request)

    // H1 FIX: Validate request has no body or proper content-type if body exists
    const contentLength = request.headers.get('content-length')
    if (contentLength && parseInt(contentLength, 10) > 0) {
      validateContentType(request)
    }

    // Rate limit: 5 account deletions per hour per IP (stricter limit for destructive action)
    const ip = getClientIp(request)
    if (!await checkRateLimit(`users-me-delete:${ip}`, 5, 3600000)) {
      throw new ApiError('Too many requests. Please try again later.', 429, ErrorCodes.RATE_LIMITED)
    }

    const user = await getMiddlewareUser()

    if (!user) {
      throw new ApiError("Unauthorized", 401, ErrorCodes.UNAUTHORIZED)
    }

    // Delete user from Supabase Auth first
    // This ensures they cannot log in anymore even if DB deletion fails partially
    // Note: This requires service role key which supabaseAdmin has
    const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(user.id)
    
    if (deleteError) {
      // If the error is that the user doesn't exist, we can proceed with DB deletion
      // Otherwise, we should fail to be safe
      const isNotFoundError = deleteError.message?.toLowerCase().includes('not found') || (deleteError as any).status === 404
      if (!isNotFoundError) {
          logger.error("[Auth] Failed to delete user from Supabase:", { error: deleteError })
        throw new ApiError("Failed to delete account from authentication service", 500, ErrorCodes.INTERNAL_ERROR)
      }
    }

    // Soft-delete user from database via Prisma extension
    // This will now automatically set deleted_at instead of hard deleting
    await withRetry(
      () => prisma.user.delete({
        where: { id: user.id }
      }),
      2,
      500
    )

    return NextResponse.json({ success: true, message: "Account deleted successfully" })
  } catch (error: unknown) {
    return handleApiError(error)
  }
}
