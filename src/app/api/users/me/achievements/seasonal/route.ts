import { NextResponse } from "next/server"
import { prisma, withRetry, DEFAULT_TX_OPTIONS } from "@/lib/prisma"
import { handleApiError, ApiError, ErrorCodes, getClientIp, getRateLimitInfo, getMiddlewareUser } from "@/lib/api-utils"
import { getSeasonalAchievementProgress, getPastSeasonAchievements } from "@/lib/gamification/seasonal-achievements"
import { logger } from "@/lib/logger"

/**
 * GET /api/users/me/achievements/seasonal
 * 
 * Returns seasonal achievement progress for the authenticated user.
 * 
 * Query params:
 * - include_history=true: Include past seasons with completed/missed achievements
 * 
 * Response includes:
 * - Current season info (code, name, days remaining, ends_at)
 * - Seasonal achievements with progress
 * - Seasonal stats (chapters read this season, streak max, etc.)
 * - Past seasons with achievements (completed / missed) if requested
 * 
 * Rules:
 * - Seasonal achievements reset every quarter
 * - XP from seasonal achievements goes to season_xp only
 * - Old seasons remain visible as "completed / missed"
 */
export async function GET(request: Request) {
  try {
    const ip = getClientIp(request)
    const rateLimitKey = `seasonal-achievements:${ip}`
    
    const rateLimitInfo = await getRateLimitInfo(rateLimitKey, 60, 60000)
    if (!rateLimitInfo.allowed) {
      const error = new ApiError("Too many requests", 429, ErrorCodes.RATE_LIMITED)
      ;(error as { retryAfter?: number }).retryAfter = Math.ceil((rateLimitInfo.reset - Date.now()) / 1000)
      throw error
    }

    const user = await getMiddlewareUser()

    if (!user) {
      throw new ApiError("Unauthorized", 401, ErrorCodes.UNAUTHORIZED)
    }

    const url = new URL(request.url)
    const includeHistory = url.searchParams.get('include_history') === 'true'

    const result = await withRetry(
      () => prisma.$transaction(async (tx) => {
        const current = await getSeasonalAchievementProgress(tx, user.id)
        const history = includeHistory ? await getPastSeasonAchievements(tx, user.id) : []
        return { current, history }
      }, DEFAULT_TX_OPTIONS),
      2,
      200
    )

    const unlockedCount = result.current.achievements.filter(a => a.is_unlocked).length
    const totalCount = result.current.achievements.length
    const inProgressCount = result.current.achievements.filter(
      a => !a.is_unlocked && a.progress_percent > 0 && !a.is_end_of_season
    ).length

    return NextResponse.json({
      season: result.current.season,
      achievements: result.current.achievements,
      stats: {
        ...result.current.stats,
        unlocked_count: unlockedCount,
        total_count: totalCount,
        in_progress_count: inProgressCount,
      },
      ...(includeHistory && { past_seasons: result.history }),
    }, {
      headers: {
        'X-RateLimit-Limit': rateLimitInfo.limit.toString(),
        'X-RateLimit-Remaining': rateLimitInfo.remaining.toString(),
        'X-RateLimit-Reset': rateLimitInfo.reset.toString(),
        'Cache-Control': 'private, max-age=60',
      }
    })
  } catch (error: unknown) {
    return handleApiError(error)
  }
}
