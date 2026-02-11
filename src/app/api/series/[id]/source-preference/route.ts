import { prisma } from "@/lib/prisma"
import { NextResponse } from "next/server"
import { checkRateLimit, handleApiError, ApiError, ErrorCodes, getClientIp, validateOrigin, validateContentType, validateJsonSize, validateUUID, getMiddlewareUser } from "@/lib/api-utils"

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: seriesId } = await params;
    validateUUID(seriesId, 'seriesId');
    const ip = getClientIp(request);
    if (!await checkRateLimit(`series-source-pref-get:${ip}`, 60, 60000)) {
      throw new ApiError("Too many requests. Please wait a moment.", 429, ErrorCodes.RATE_LIMITED);
    }

    const user = await getMiddlewareUser()
    if (!user) {
      throw new ApiError("Unauthorized", 401, ErrorCodes.UNAUTHORIZED);
    }

    const preference = await prisma.userSeriesSourcePreference.findUnique({
      where: {
        user_id_series_id: {
          user_id: user.id,
          series_id: seriesId,
        },
      },
    })

    return NextResponse.json({ preference })
  } catch (error: unknown) {
    return handleApiError(error);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: seriesId } = await params;
    validateUUID(seriesId, 'seriesId');
    validateOrigin(request);

    const ip = getClientIp(request);
    if (!await checkRateLimit(`series-source-pref-post:${ip}`, 20, 60000)) {
      throw new ApiError("Too many requests. Please wait a moment.", 429, ErrorCodes.RATE_LIMITED);
    }

    validateContentType(request);
    await validateJsonSize(request);

    const user = await getMiddlewareUser()
    if (!user) {
      throw new ApiError("Unauthorized", 401, ErrorCodes.UNAUTHORIZED);
    }

      let body;
    try {
      body = await request.json();
    } catch {
      throw new ApiError("Invalid JSON body", 400, ErrorCodes.BAD_REQUEST);
    }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new ApiError('Invalid JSON body', 400, ErrorCodes.BAD_REQUEST);
      }
      const { sourceName } = body;

    if (sourceName !== null && (typeof sourceName !== 'string' || sourceName.length === 0 || sourceName.length > 50)) {
      throw new ApiError("Invalid source name.", 400, ErrorCodes.INVALID_INPUT);
    }

    if (sourceName === null) {
      // Remove preference
      await prisma.userSeriesSourcePreference.deleteMany({
        where: {
          user_id: user.id,
          series_id: seriesId,
        },
      })
    } else {
      // Upsert preference
      await prisma.userSeriesSourcePreference.upsert({
        where: {
          user_id_series_id: {
            user_id: user.id,
            series_id: seriesId,
          },
        },
        update: {
          source_name: sourceName.toLowerCase(),
        },
        create: {
          user_id: user.id,
          series_id: seriesId,
          source_name: sourceName.toLowerCase(),
        },
      })
    }

    return NextResponse.json({ success: true })
  } catch (error: unknown) {
    return handleApiError(error);
  }
}
