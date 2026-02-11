import { prisma, withRetry } from "@/lib/prisma"
import { NextRequest, NextResponse } from "next/server"
import { checkRateLimit, getClientIp, handleApiError, ApiError, ErrorCodes, validateUUID } from "@/lib/api-utils"
import { MangaUpdatesClient } from "@/lib/mangaupdates/client"
import { redisApi, REDIS_KEY_PREFIX } from "@/lib/redis"
import { logger } from "@/lib/logger"

// Cache TTL: 15 minutes for releases data
const RELEASES_CACHE_TTL_SECONDS = 15 * 60

/**
 * Cache a response in Redis with TTL
 */
async function cacheResponse(key: string, data: unknown): Promise<void> {
  try {
    await redisApi.setex(key, RELEASES_CACHE_TTL_SECONDS, JSON.stringify(data))
  } catch (e: unknown) {
    logger.warn('[releases] Cache write error:', { error: e instanceof Error ? e.message : String(e) })
  }
}

/**
 * GET /api/series/:id/releases
 * 
 * Fetches release information from MangaUpdates for a series.
 * This shows where chapters are available (scanlation groups) without providing direct links.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ip = getClientIp(request);
    if (!await checkRateLimit(`releases:${ip}`, 30, 60000)) {
      throw new ApiError("Too many requests. Please wait a moment.", 429, ErrorCodes.RATE_LIMITED);
    }

    const { id } = await params
    const { searchParams } = new URL(request.url)
    const limit = Math.min(parseInt(searchParams.get("limit") || "10"), 50)

    validateUUID(id, 'series ID')

    // Check cache first
    const cacheKey = `${REDIS_KEY_PREFIX}releases:${id}:${limit}`
    try {
      const cached = await redisApi.get(cacheKey)
      if (cached) {
        const data = JSON.parse(cached)
        return NextResponse.json({ ...data, cached: true })
      }
    } catch (e: unknown) {
      // Cache miss or error - continue to fetch
      logger.warn('[releases] Cache read error:', { error: e instanceof Error ? e.message : String(e) })
    }

    // First, check if series exists and has a MangaUpdates ID
    const series = await withRetry(() =>
      prisma.series.findUnique({
        where: { id },
        select: { 
          id: true, 
          title: true,
          mangaupdates_series_id: true 
        },
      })
    )

    if (!series) {
      return NextResponse.json(
        { error: "Series not found", code: ErrorCodes.NOT_FOUND },
        { status: 404 }
      )
    }

    // Check for stored releases first (from our database)
    const storedReleases = await prisma.mangaUpdatesRelease.findMany({
      where: { series_id: id },
      orderBy: { published_at: 'desc' },
      take: limit,
    })

    if (storedReleases.length > 0) {
      const responseData = {
        releases: storedReleases.map(release => ({
          id: release.id,
          title: release.title,
          chapter: release.chapter,
          volume: release.volume,
          language: release.language,
          published_at: release.published_at?.toISOString() || null,
          // Extract group info from metadata if available
          groups: extractGroupsFromMetadata(release.metadata),
        })),
        source: 'database',
        // Convert BigInt to string to avoid precision loss in JSON
        mangaupdates_series_id: series.mangaupdates_series_id ? String(series.mangaupdates_series_id) : null,
      }
      
      // Cache the response
      cacheResponse(cacheKey, responseData).catch(() => {})
      
      return NextResponse.json(responseData)
    }

    // If no stored releases but we have a MangaUpdates ID, try to fetch live
    if (series.mangaupdates_series_id) {
      try {
        const client = new MangaUpdatesClient()
        // Poll recent releases (last 30 days) and filter for this series
        const releases = await client.pollLatestReleases({ days: 30, page: 1 })
        const seriesReleases = releases.filter(
          r => r.series.series_id === Number(series.mangaupdates_series_id)
        ).slice(0, limit)

        if (seriesReleases.length > 0) {
          const responseData = {
            releases: seriesReleases.map(release => ({
              id: release.id,
              title: release.title,
              chapter: release.chapter,
              volume: release.volume,
              language: null,
              published_at: release.release_date,
              groups: release.groups.map(g => ({
                name: g.name,
                id: g.group_id,
              })),
            })),
            source: 'live',
            // Keep as string for consistency
            mangaupdates_series_id: String(series.mangaupdates_series_id),
          }
          
          // Cache the response
          cacheResponse(cacheKey, responseData).catch(() => {})
          
          return NextResponse.json(responseData)
        }
      } catch (e: unknown) {
        // If live fetch fails, return empty - don't fail the whole request
        logger.error('[releases] Failed to fetch live releases:', { error: e instanceof Error ? e.message : String(e) })
      }
    }

    // No releases found (don't cache empty results - they might fill in later)
    return NextResponse.json({
      releases: [],
      source: 'none',
      mangaupdates_series_id: series.mangaupdates_series_id ? String(series.mangaupdates_series_id) : null,
    })

  } catch (error: unknown) {
    return handleApiError(error)
  }
}

/**
 * Extract group information from stored metadata JSON
 */
function extractGroupsFromMetadata(metadata: unknown): Array<{ name: string; id?: number }> {
  if (!metadata || typeof metadata !== 'object') return []
  
  const meta = metadata as Record<string, unknown>
  
  // Handle various possible metadata formats
  if (Array.isArray(meta.groups)) {
    return meta.groups.map((g: unknown) => {
      if (typeof g === 'string') return { name: g }
      if (typeof g === 'object' && g !== null) {
        const group = g as Record<string, unknown>
        return {
          name: String(group.name || group.group_name || 'Unknown'),
          id: typeof group.group_id === 'number' ? group.group_id : undefined,
        }
      }
      return { name: 'Unknown' }
    })
  }
  
  if (meta.group_name && typeof meta.group_name === 'string') {
    return [{ name: meta.group_name }]
  }
  
  return []
}
