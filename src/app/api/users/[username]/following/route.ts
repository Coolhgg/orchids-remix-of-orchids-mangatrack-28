import { NextResponse } from "next/server";
import { getFollowing } from "@/lib/social-utils";
import { checkRateLimit, validateUsername, parsePaginationParams, handleApiError, getClientIp, ApiError, ErrorCodes, getMiddlewareUser } from "@/lib/api-utils";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ username: string }> }
) {
  try {
    // Rate limit: 30 requests per minute per IP
    const ip = getClientIp(request);
    if (!await checkRateLimit(`following:${ip}`, 30, 60000)) {
      throw new ApiError("Too many requests. Please wait a moment.", 429, ErrorCodes.RATE_LIMITED);
    }

    const user = await getMiddlewareUser();

    const { username } = await params;

    // Validate username format to prevent injection
    if (!validateUsername(username)) {
      return NextResponse.json(
        { error: "Invalid username format" },
        { status: 400 }
      );
    }

    const { searchParams } = new URL(request.url);
    const { page, limit } = parsePaginationParams(searchParams);

    const following = await getFollowing(username, { page, limit }, user?.id);

    return NextResponse.json(following);
  } catch (error: unknown) {
    return handleApiError(error);
  }
}
