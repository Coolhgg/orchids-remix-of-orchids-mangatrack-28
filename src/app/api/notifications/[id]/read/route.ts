import { NextRequest, NextResponse } from "next/server";
import { markNotificationsAsRead } from "@/lib/social-utils";
import { checkRateLimit, handleApiError, validateUUID, ApiError, ErrorCodes, validateOrigin, getClientIp, validateContentType, getMiddlewareUser } from "@/lib/api-utils";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
    try {
      // CSRF Protection
      validateOrigin(request);

      // Content-Type validation
      validateContentType(request);

      // Rate limit: 60 requests per minute per IP

    const ip = getClientIp(request);
    if (!await checkRateLimit(`notification-read:${ip}`, 60, 60000)) {
      throw new ApiError("Too many requests. Please wait a moment.", 429, ErrorCodes.RATE_LIMITED);
    }

      const user = await getMiddlewareUser();

      if (!user) {
        throw new ApiError("Unauthorized", 401, ErrorCodes.UNAUTHORIZED);
      }

    const { id } = await params;

    // Validate UUID format to prevent injection
    validateUUID(id, "notification ID");

    await markNotificationsAsRead(user.id, id);

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    return handleApiError(error);
  }
}
