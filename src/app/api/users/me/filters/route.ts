import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { FilterSchema } from "@/lib/schemas/filters"
import { checkRateLimit, validateOrigin, sanitizeInput, handleApiError, ApiError, ErrorCodes, getClientIp, validateContentType, validateJsonSize, logSecurityEvent, getMiddlewareUser } from "@/lib/api-utils"
import { logger } from "@/lib/logger"

export async function GET(request: NextRequest) {
  try {
    // Rate limit: 30 requests per minute per IP
    const ip = getClientIp(request);
    if (!await checkRateLimit(`filters-get:${ip}`, 30, 60000)) {
      throw new ApiError("Too many requests. Please wait a moment.", 429, ErrorCodes.RATE_LIMITED)
    }

    const user = await getMiddlewareUser()

    if (!user) {
      throw new ApiError("Unauthorized", 401, ErrorCodes.UNAUTHORIZED)
    }

    const filters = await prisma.savedFilter.findMany({
      where: { user_id: user.id },
      orderBy: { created_at: 'desc' },
      take: 50, // Prevent excessive data retrieval
    })

    return NextResponse.json(filters || [])
  } catch (error: unknown) {
    return handleApiError(error)
  }
}

export async function POST(request: NextRequest) {
  try {
    // CSRF Protection
    validateOrigin(request)

    // Content-Type & Size validation
    validateContentType(request)
    await validateJsonSize(request, 64 * 1024) // 64KB limit for filter payloads

    // Rate limit: 10 creations per minute per IP
    const ip = getClientIp(request)
    if (!await checkRateLimit(`filters-create:${ip}`, 10, 60000)) {
      throw new ApiError("Too many requests. Please wait a moment.", 429, ErrorCodes.RATE_LIMITED)
    }

    const user = await getMiddlewareUser()

    if (!user) {
      throw new ApiError("Unauthorized", 401, ErrorCodes.UNAUTHORIZED)
    }

    let body
    try {
      body = await request.json()
    } catch {
      throw new ApiError("Invalid JSON body", 400, ErrorCodes.BAD_REQUEST)
    }

    const { name, payload, is_default } = body

    // Validate and sanitize name
    if (!name || typeof name !== 'string') {
      throw new ApiError("Filter name is required", 400, ErrorCodes.VALIDATION_ERROR)
    }
    
    const sanitizedName = sanitizeInput(name, 100).trim()
    if (sanitizedName.length < 1 || sanitizedName.length > 100) {
      throw new ApiError("Filter name must be between 1 and 100 characters", 400, ErrorCodes.VALIDATION_ERROR)
    }

    // Validate payload against FilterSchema
    const validated = FilterSchema.safeParse(payload)
    if (!validated.success) {
      throw new ApiError("Invalid filter payload", 400, ErrorCodes.VALIDATION_ERROR)
    }

    const validatedPayload = { ...validated.data }
    if (validatedPayload.q) {
      validatedPayload.q = sanitizeInput(validatedPayload.q, 200)
    }

    // Check user hasn't exceeded max saved filters (prevent abuse)
    const count = await prisma.savedFilter.count({
      where: { user_id: user.id },
    })

    if (count >= 50) {
      throw new ApiError("Maximum saved filters limit reached (50)", 400, ErrorCodes.VALIDATION_ERROR)
    }

    // If setting as default, unset previous default
    if (is_default) {
      await prisma.savedFilter.updateMany({
        where: { user_id: user.id },
        data: { is_default: false },
      })
    }

    const data = await prisma.savedFilter.create({
      data: {
        user_id: user.id,
        name: sanitizedName,
        filter_payload: validatedPayload,
        is_default: !!is_default,
      },
    })

    // Log the event (Audit Logging enhancement)
    await logSecurityEvent({
      userId: user.id,
      event: 'FILTER_CREATE',
      status: 'success',
      ipAddress: ip,
      userAgent: request.headers.get('user-agent'),
      metadata: { filter_id: data.id, name: sanitizedName }
    })

    return NextResponse.json(data, { status: 201 })
  } catch (error: unknown) {
    return handleApiError(error)
  }
}
