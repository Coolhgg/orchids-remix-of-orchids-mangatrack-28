import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { seriesResolutionQueue } from "@/lib/queues"
import { CrawlGatekeeper } from "@/lib/crawl-gatekeeper"
import { getSourceFromUrl } from "@/lib/constants/sources"
import { extractMangaDexId } from "@/lib/mangadex-utils"
import { checkRateLimit, ApiError, ErrorCodes, handleApiError, getClientIp, validateOrigin, validateContentType, validateJsonSize, generateRequestId, validateUUID, getMiddlewareUser } from "@/lib/api-utils"
import { logger } from "@/lib/logger"

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = generateRequestId();
  
  try {
    validateOrigin(req)
    validateContentType(req)
    await validateJsonSize(req)
    const { id: seriesId } = await params
    validateUUID(seriesId, 'seriesId')
    
    // Rate limit: 10 updates per minute per IP
    const ip = getClientIp(req);
    if (!await checkRateLimit(`series-metadata:${ip}`, 10, 60000)) {
      throw new ApiError('Too many requests. Please wait a moment.', 429, ErrorCodes.RATE_LIMITED)
    }

    const user = await getMiddlewareUser()

    if (!user) {
      throw new ApiError('Unauthorized', 401, ErrorCodes.UNAUTHORIZED)
    }

    let body;
    try {
      body = await req.json()
    } catch {
      throw new ApiError('Invalid JSON body', 400, ErrorCodes.BAD_REQUEST)
    }
      if (!body || typeof body !== 'object') {
        throw new ApiError('Invalid JSON body', 400, ErrorCodes.BAD_REQUEST);
      }
      const { canonical_url } = body
    if (!canonical_url) {
      throw new ApiError('canonical_url is required', 400, ErrorCodes.VALIDATION_ERROR)
    }

    const platform = getSourceFromUrl(canonical_url)
    if (!platform || !['MangaDex', 'AniList', 'MyAnimeList'].includes(platform)) {
      throw new ApiError('Only MangaDex, AniList, or MAL are accepted', 400, ErrorCodes.VALIDATION_ERROR)
    }

    // 1. Handle MangaDex specially (dual purpose: sync + metadata)
    if (platform === 'MangaDex') {
      const sourceId = extractMangaDexId(canonical_url) || canonical_url

      const seriesSource = await prisma.seriesSource.upsert({
        where: {
          source_name_source_id: {
            source_name: 'MangaDex',
            source_id: sourceId
          }
        },
        update: {
          series_id: seriesId,
          source_url: canonical_url,
        },
        create: {
          series_id: seriesId,
          source_name: 'MangaDex',
          source_id: sourceId,
          source_url: canonical_url,
          sync_priority: 'WARM'
        }
      })

      // Trigger sync for MangaDex
      const series = await prisma.series.findUnique({
        where: { id: seriesId },
        select: { catalog_tier: true }
      });

      await CrawlGatekeeper.enqueueIfAllowed(
        seriesSource.id,
        series?.catalog_tier || 'C',
        'USER_REQUEST',
        { 
          sourceId: seriesSource.id,
          seriesId: seriesId,
          force: true 
        }
      );
    }

    // 2. Update series external_links
    const series = await prisma.series.findUnique({
      where: { id: seriesId },
      select: { external_links: true }
    })

    const links = (series?.external_links as any) || {}
    links[platform.toLowerCase()] = canonical_url

    await prisma.series.update({
      where: { id: seriesId },
      data: {
        external_links: links,
        // If it's mangadex, we also update mangadex_id
        ...(platform === 'MangaDex' ? { mangadex_id: extractMangaDexId(canonical_url) } : {})
      }
    })

    // 3. Queue metadata resolution
    await seriesResolutionQueue.add(
      `resolve-${seriesId}-${Date.now()}`,
      { 
        seriesId: seriesId,
        platform: platform.toLowerCase(),
        url: canonical_url,
        force: true
      },
      { priority: 1 }
    )

    return NextResponse.json({
      success: true,
      message: "Metadata update queued."
    })

  } catch (error: unknown) {
    logger.error("[METADATA_POST]", { error: error instanceof Error ? error.message : String(error) })
    return handleApiError(error, requestId)
  }
}
