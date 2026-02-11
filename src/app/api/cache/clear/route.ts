import { NextRequest } from "next/server"
import { withErrorHandling, ApiError, ErrorCodes, validateOrigin, checkRateLimit, getClientIp, getMiddlewareUser } from "@/lib/api-utils"
import { redis, REDIS_KEY_PREFIX } from "@/lib/redis"
import { revalidatePath } from "next/cache"
import { logger } from "@/lib/logger"

export async function POST(request: NextRequest) {
  return withErrorHandling(async () => {
    validateOrigin(request)

    const user = await getMiddlewareUser()
    if (!user) {
      throw new ApiError("Unauthorized", 401, ErrorCodes.UNAUTHORIZED)
    }

    // QA FIX: Add rate limiting — destructive operation, max 3 per minute
    const ip = getClientIp(request)
    if (!await checkRateLimit(`cache-clear:${user.id}:${ip}`, 3, 60000)) {
      throw new ApiError("Too many requests. Please wait before clearing caches again.", 429, ErrorCodes.RATE_LIMITED)
    }

    const results: Record<string, number | string> = {}

    // Clear Redis caches by prefix (not FLUSHDB — preserves rate limits, locks, etc.)
    const prefixes = [
      `${REDIS_KEY_PREFIX}search:cache:`,
      `${REDIS_KEY_PREFIX}feed:`,
      `mu:cache:`,
      `cache:`,
    ]

    let totalDeleted = 0
    for (const prefix of prefixes) {
      let cursor = "0"
      let deleted = 0
      do {
        const [nextCursor, keys] = await redis.scan(cursor, "MATCH", `${prefix}*`, "COUNT", 200)
        cursor = nextCursor
        if (keys.length > 0) {
          await redis.del(...keys)
          deleted += keys.length
        }
      } while (cursor !== "0")
      if (deleted > 0) {
        results[prefix] = deleted
      }
      totalDeleted += deleted
    }
    results.total_redis_keys = totalDeleted

    // Revalidate key Next.js paths
    revalidatePath("/", "layout")
    revalidatePath("/library", "page")
    revalidatePath("/feed", "page")
    results.next_revalidated = "layout + key pages"

    logger.info("[Cache] Cleared by user", { userId: user.id, results })

    return { cleared: true, results }
  })
}
