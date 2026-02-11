import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { checkRateLimit, handleApiError, parsePaginationParams, ApiError, ErrorCodes, getClientIp, getMiddlewareUser } from "@/lib/api-utils"

export async function GET(request: NextRequest) {
  try {
    // Rate limit: 30 requests per minute per IP
    const ip = getClientIp(request);
    if (!await checkRateLimit(`social_me:${ip}`, 30, 60000)) {
      throw new ApiError("Too many requests. Please wait a moment.", 429, ErrorCodes.RATE_LIMITED);
    }

    const user = await getMiddlewareUser()
    if (!user) {
      throw new ApiError("Unauthorized", 401, ErrorCodes.UNAUTHORIZED);
    }

    const { searchParams } = new URL(request.url)
    const { page, limit, offset } = parsePaginationParams(searchParams)

      const [followingData, followersData, followingCount, followersCount] = await Promise.all([
        prisma.follow.findMany({
          where: { follower_id: user.id },
          skip: offset,
          take: limit,
          orderBy: { created_at: 'desc' },
          include: {
            users_follows_following_idTousers: {
              select: {
                id: true,
                username: true,
                avatar_url: true,
                xp: true,
                level: true,
              },
            },
          },
        }),
        prisma.follow.findMany({
          where: { following_id: user.id },
          skip: offset,
          take: limit,
          orderBy: { created_at: 'desc' },
          include: {
            users_follows_follower_idTousers: {
              select: {
                id: true,
                username: true,
                avatar_url: true,
                xp: true,
                level: true,
              },
            },
          },
        }),
        prisma.follow.count({ where: { follower_id: user.id } }),
        prisma.follow.count({ where: { following_id: user.id } }),
      ])

    const followingIds = followingData.map((f) => f.following_id)

    const suggested = await prisma.user.findMany({
      where: {
        id: {
          notIn: [user.id, ...followingIds],
        },
      },
      select: {
        id: true,
        username: true,
        avatar_url: true,
        xp: true,
        level: true,
      },
      orderBy: { xp: "desc" },
      take: 6,
    })

      return NextResponse.json({
        following: {
          items: followingData.map((f) => ({
            id: f.id,
            user: f.users_follows_following_idTousers,
          })),
          pagination: { page, limit, total: followingCount }
        },
        followers: {
          items: followersData.map((f) => ({
            id: f.id,
            user: f.users_follows_follower_idTousers,
          })),
          pagination: { page, limit, total: followersCount }
        },
        suggested,
      })
  } catch (error: unknown) {
    return handleApiError(error)
  }
}
