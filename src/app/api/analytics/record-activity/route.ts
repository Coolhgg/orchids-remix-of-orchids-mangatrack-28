import { NextRequest, NextResponse } from "next/server"
import { checkRateLimit, handleApiError, getClientIp, ApiError, ErrorCodes, validateOrigin, validateContentType, validateJsonSize, getMiddlewareUser, UUID_REGEX } from "@/lib/api-utils"
import { recordActivity, ActivityEventType } from "@/lib/analytics/record"

// Events that require authentication (user-specific actions)
const AUTH_REQUIRED_EVENTS: Set<ActivityEventType> = new Set([
  'chapter_read',
  'series_followed',
]);

export async function POST(request: NextRequest) {
  const ip = getClientIp(request);
  
  try {
    // Rate limiting (stricter for unauthenticated requests to prevent score inflation)
    const user = await getMiddlewareUser()
    const rateLimitMax = user ? 100 : 30;
    if (!await checkRateLimit(`activity-record:${ip}`, rateLimitMax, 60000)) {
      throw new ApiError('Too many requests', 429, ErrorCodes.RATE_LIMITED);
    }

    // CSRF Protection for state-changing request
    validateOrigin(request);

    // Content-Type validation
    validateContentType(request);

    // Payload size validation (prevent large payloads)
      await validateJsonSize(request, 10 * 1024); // 10KB max

      let body;
    try {
      body = await request.json();
    } catch {
      throw new ApiError('Invalid JSON body', 400, ErrorCodes.BAD_REQUEST);
    }

    if (!body || typeof body !== 'object') {
      throw new ApiError('Invalid JSON body', 400, ErrorCodes.BAD_REQUEST);
    }

    const { seriesId, eventType, chapterId, sourceName } = body;

    // Validate required fields
    if (!seriesId || !eventType) {
      throw new ApiError('Missing seriesId or eventType', 400, ErrorCodes.BAD_REQUEST);
    }

    // Validate UUID format for seriesId
    if (!UUID_REGEX.test(seriesId)) {
      throw new ApiError('Invalid seriesId format', 400, ErrorCodes.VALIDATION_ERROR);
    }

    // Validate chapterId if provided
    if (chapterId && !UUID_REGEX.test(chapterId)) {
      throw new ApiError('Invalid chapterId format', 400, ErrorCodes.VALIDATION_ERROR);
    }

    // Validate sourceName length if provided
    if (sourceName && (typeof sourceName !== 'string' || sourceName.length > 50)) {
      throw new ApiError('Invalid sourceName', 400, ErrorCodes.VALIDATION_ERROR);
    }

    const validEvents: ActivityEventType[] = [
      'chapter_read', 
      'series_followed', 
      'search_impression',
      'chapter_detected',
      'chapter_source_added'
    ]

    if (!validEvents.includes(eventType as ActivityEventType)) {
      throw new ApiError('Invalid eventType', 400, ErrorCodes.VALIDATION_ERROR);
    }

    // QA FIX: Require authentication for user-specific events
    // Events like chapter_read and series_followed must have a verified user
    if (AUTH_REQUIRED_EVENTS.has(eventType as ActivityEventType) && !user) {
      throw new ApiError('Unauthorized', 401, ErrorCodes.UNAUTHORIZED);
    }

    await recordActivity({
      series_id: seriesId,
      user_id: user?.id,
      chapter_id: chapterId,
      source_name: sourceName,
      event_type: eventType as ActivityEventType
    })

    return NextResponse.json({ success: true })

  } catch (error: unknown) {
    return handleApiError(error)
  }
}
