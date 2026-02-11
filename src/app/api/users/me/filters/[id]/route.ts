import { prisma } from "@/lib/prisma"
import { NextRequest, NextResponse } from "next/server"
import { checkRateLimit, validateOrigin, validateUUID, sanitizeInput, handleApiError, ApiError, getClientIp, logSecurityEvent, ErrorCodes, validateContentType, validateJsonSize, getMiddlewareUser } from "@/lib/api-utils"

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    validateOrigin(request)
    validateContentType(request)
    await validateJsonSize(request)

    const ip = getClientIp(request);
    if (!await checkRateLimit(`filters-update:${ip}`, 20, 60000)) {
      throw new ApiError("Too many requests. Please wait a moment.", 429, ErrorCodes.RATE_LIMITED)
    }

    const user = await getMiddlewareUser()
    if (!user) {
      throw new ApiError("Unauthorized", 401, ErrorCodes.UNAUTHORIZED)
    }

    const { id } = await params
    validateUUID(id, 'filter id')

    let body
    try {
      body = await request.json()
    } catch {
      throw new ApiError("Invalid JSON body", 400, ErrorCodes.BAD_REQUEST)
    }

    const { name, is_default } = body

    const updateData: Record<string, any> = {
      updated_at: new Date(),
    }

    if (name !== undefined) {
      if (typeof name !== 'string') {
        throw new ApiError("Name must be a string", 400, ErrorCodes.VALIDATION_ERROR)
      }
      const sanitizedName = sanitizeInput(name, 100).trim()
      if (sanitizedName.length < 1 || sanitizedName.length > 100) {
        throw new ApiError("Filter name must be between 1 and 100 characters", 400, ErrorCodes.VALIDATION_ERROR)
      }
      updateData.name = sanitizedName
    }

    if (is_default !== undefined) {
      updateData.is_default = !!is_default

      if (is_default) {
        await prisma.savedFilter.updateMany({
          where: { user_id: user.id, id: { not: id } },
          data: { is_default: false },
        })
      }
    }

    const data = await prisma.savedFilter.update({
      where: { id, user_id: user.id },
      data: updateData,
    }).catch(() => null)

    if (!data) {
      throw new ApiError("Filter not found", 404, ErrorCodes.NOT_FOUND)
    }

    await logSecurityEvent({
      userId: user.id,
      event: 'FILTER_UPDATE',
      status: 'success',
      ipAddress: ip,
      userAgent: request.headers.get('user-agent'),
      metadata: { filter_id: id, updates: Object.keys(updateData) }
    })

    return NextResponse.json(data)
  } catch (error: unknown) {
    return handleApiError(error)
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    validateOrigin(request)

    const ip = getClientIp(request);
    if (!await checkRateLimit(`filters-delete:${ip}`, 20, 60000)) {
      throw new ApiError("Too many requests. Please wait a moment.", 429, ErrorCodes.RATE_LIMITED)
    }

    const user = await getMiddlewareUser()
    if (!user) {
      throw new ApiError("Unauthorized", 401, ErrorCodes.UNAUTHORIZED)
    }

    const { id } = await params
    validateUUID(id, 'filter id')

    const existing = await prisma.savedFilter.findFirst({
      where: { id, user_id: user.id },
      select: { id: true },
    })

    if (!existing) {
      throw new ApiError("Filter not found", 404, ErrorCodes.NOT_FOUND)
    }

    await prisma.savedFilter.delete({
      where: { id },
    })

    await logSecurityEvent({
      userId: user.id,
      event: 'FILTER_DELETE',
      status: 'success',
      ipAddress: ip,
      userAgent: request.headers.get('user-agent'),
      metadata: { filter_id: id }
    })

    return new NextResponse(null, { status: 204 })
  } catch (error: unknown) {
    return handleApiError(error)
  }
}
