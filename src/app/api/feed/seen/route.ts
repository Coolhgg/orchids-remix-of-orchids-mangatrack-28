import { prisma } from "@/lib/prisma"
import { NextRequest, NextResponse } from "next/server"
import { checkRateLimit, getClientIp, handleApiError, ApiError, ErrorCodes, validateOrigin, validateContentType, validateJsonSize, getMiddlewareUser } from "@/lib/api-utils"
import { logger } from "@/lib/logger"

export async function POST(request: NextRequest) {
  try {
    // CSRF Protection
    validateOrigin(request);

    // BUG 58: Validate Content-Type
    validateContentType(request);

    // BUG 57: Validate JSON Size
    await validateJsonSize(request);

    const ip = getClientIp(request);
    if (!await checkRateLimit(`feed-seen:${ip}`, 30, 60000)) {
      throw new ApiError("Too many requests. Please wait a moment.", 429, ErrorCodes.RATE_LIMITED);
    }

    const user = await getMiddlewareUser();

    if (!user) {
      throw new ApiError("Unauthorized", 401, ErrorCodes.UNAUTHORIZED);
    }

      let body;
    try {
      body = await request.json();
    } catch {
      throw new ApiError("Invalid JSON body", 400, ErrorCodes.BAD_REQUEST);
    }
      if (!body || typeof body !== 'object') {
        throw new ApiError('Invalid JSON body', 400, ErrorCodes.BAD_REQUEST);
      }
      const { last_seen_at } = body;
    let newTimestamp: Date;
    if (last_seen_at) {
      newTimestamp = new Date(last_seen_at);
      if (isNaN(newTimestamp.getTime())) {
        throw new ApiError("Invalid date format for last_seen_at", 400, ErrorCodes.BAD_REQUEST);
      }
      // Cap future dates to prevent skipping all future feed items
      const maxAllowed = new Date(Date.now() + 60_000); // 1 min tolerance
      if (newTimestamp > maxAllowed) {
        newTimestamp = new Date();
      }
    } else {
      newTimestamp = new Date();
    }

    // Only update if the new timestamp is further in the future
    await prisma.user.update({
      where: { 
        id: user.id,
        OR: [
          { feed_last_seen_at: null },
          { feed_last_seen_at: { lt: newTimestamp } }
        ]
      },
      data: {
        feed_last_seen_at: newTimestamp
      }
    }).catch(err => {
      // P2025 = "Record to update not found" — expected when watermark is already ahead
      const errCode = (err as { code?: string })?.code;
      if (errCode === 'P2025') {
        logger.debug("Feed watermark not updated (already ahead)");
        return;
      }
      // Re-throw unexpected errors (connection failures, etc.)
      throw err;
    });

    return NextResponse.json({ success: true, feed_last_seen_at: newTimestamp.toISOString() });
  } catch (error: unknown) {
    return handleApiError(error);
  }
}
