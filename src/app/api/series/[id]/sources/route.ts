import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { syncSourceQueue } from "@/lib/queues"
import { getSourceFromUrl } from "@/lib/constants/sources"
import { handleApiError, ApiError, ErrorCodes, checkRateLimit, getClientIp, validateOrigin, validateContentType, validateJsonSize, validateUUID, getMiddlewareUser } from "@/lib/api-utils"
import { logger } from "@/lib/logger"

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    validateOrigin(req)
    validateContentType(req)
    await validateJsonSize(req)
    const ip = getClientIp(req)
    if (!await checkRateLimit(`series-sources:${ip}`, 10, 60000)) {
      throw new ApiError("Too many requests. Please wait a moment.", 429, ErrorCodes.RATE_LIMITED)
    }

    const { id: seriesId } = await params
    validateUUID(seriesId, 'seriesId')
    const user = await getMiddlewareUser();

    if (!user) {
      throw new ApiError("Unauthorized", 401, ErrorCodes.UNAUTHORIZED)
    }

    let body;
    try {
      body = await req.json();
    } catch {
      throw new ApiError("Invalid JSON body", 400, ErrorCodes.BAD_REQUEST)
    }
      if (!body || typeof body !== 'object') {
        throw new ApiError('Invalid JSON body', 400, ErrorCodes.BAD_REQUEST);
      }
      const { source_url } = body;
    if (!source_url) {
      throw new ApiError("source_url is required", 400, ErrorCodes.BAD_REQUEST)
    }

    const sourceName = getSourceFromUrl(source_url)
    if (!sourceName) {
      throw new ApiError("Unsupported source site", 400, ErrorCodes.BAD_REQUEST)
    }

    let sourceId = source_url
    try {
      const url = new URL(source_url)
      if (sourceName === 'MangaDex') {
        sourceId = url.pathname.split('/').pop() || source_url
      } else {
        sourceId = url.pathname
      }
    } catch (err: unknown) {
      logger.warn(`[SeriesSource] Failed to parse source URL "${source_url}", using raw URL as sourceId:`, { error: err instanceof Error ? err.message : String(err) })
    }

    const seriesSource = await prisma.seriesSource.upsert({
      where: {
        source_name_source_id: {
          source_name: sourceName,
          source_id: sourceId
        }
      },
      update: {
        series_id: seriesId,
        source_url: source_url,
        source_status: 'active',
      },
      create: {
        series_id: seriesId,
        source_name: sourceName,
        source_id: sourceId,
        source_url: source_url,
        sync_priority: 'WARM',
        source_status: 'active',
      }
    })

    await prisma.libraryEntry.updateMany({
      where: {
        user_id: user.id,
        series_id: seriesId
      },
      data: {
        source_url: source_url,
        source_name: sourceName
      }
    })

    await syncSourceQueue.add(
      `sync-${seriesSource.id}`,
      { 
        sourceId: seriesSource.id,
        seriesId: seriesId,
        force: true 
      },
      { priority: 1 }
    )

    return NextResponse.json({
      success: true,
      source_id: seriesSource.id,
      message: "Source attached. Chapter sync started."
    })
  } catch (error: unknown) {
    return handleApiError(error)
  }
}
