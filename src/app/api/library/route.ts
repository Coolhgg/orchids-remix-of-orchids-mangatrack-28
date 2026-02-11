import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { prisma, prismaRead, DEFAULT_TX_OPTIONS } from '@/lib/prisma';
import { sanitizeInput, checkRateLimit, handleApiError, ApiError, ErrorCodes, validateOrigin, escapeILikePattern, getClientIp, logSecurityEvent, validateContentType, validateJsonSize, parsePaginationParams, getMiddlewareUser } from '@/lib/api-utils';
import { logger } from '@/lib/logger';
import { z } from 'zod';
import { isValidCoverUrl } from '@/lib/cover-resolver';
import { PRODUCTION_QUERIES } from '@/lib/sql/production-queries';
import { promoteSeriesTier } from '@/lib/catalog-tiers';
import { sanitizePrismaObject } from '@/lib/utils';
import { checkAchievements, UnlockedAchievement } from '@/lib/gamification/achievements';
import { validateSourceUrl, getSupportedSources, ALLOWED_HOSTS } from '@/lib/scrapers/index';
import { redisApi, REDIS_KEY_PREFIX } from '@/lib/redis';
import { invalidateLibraryCache, libraryVersionKey } from '@/lib/cache-utils';

const LIBRARY_CACHE_TTL = 60; // 60 seconds

function libraryCacheKey(userId: string, params: string): string {
  return `${REDIS_KEY_PREFIX}library:${userId}:${params}`;
}

const AddToLibrarySchema = z.object({
  seriesId: z.string().uuid('Invalid series ID format'),
  status: z.enum(['reading', 'completed', 'planning', 'dropped', 'paused']).default('reading'),
});

const MAX_OFFSET = 100000;

const LibraryQuerySchema = z.object({
  q: z.string().optional(),
  status: z.string().optional(),
  sort: z.enum(['updated', 'latest_chapter', 'title', 'rating', 'added']).default('latest_chapter'),
  limit: z.preprocess((val) => {
    const num = parseInt(val as string, 10);
    if (isNaN(num)) return 100;
    return Math.min(200, Math.max(1, num));
  }, z.number()).default(100),
  offset: z.preprocess((val) => {
    const num = parseInt(val as string, 10);
    if (isNaN(num)) return 0;
    return Math.min(MAX_OFFSET, Math.max(0, num));
  }, z.number()).default(0),
});

/**
 * v5 Audit Bug 13+16 FIX: Unified platform compatibility check
 * Uses getSupportedSources() from scrapers as single source of truth
 * Falls back to ALLOWED_HOSTS for SSRF protection
 */
function verifyPlatformCompatibility(sourceUrl: string): { 
  compatible: boolean; 
  platform: string | null;
  error?: string;
} {
  if (!sourceUrl) {
    return { compatible: false, platform: null, error: 'No source URL provided' };
  }

  try {
    const url = new URL(sourceUrl);
    const hostname = url.hostname.toLowerCase();
    
    // Primary check: Use scrapers' getSupportedSources as source of truth
    const supportedSources = getSupportedSources();
    for (const platform of supportedSources) {
      if (hostname.includes(platform.toLowerCase())) {
        return { compatible: true, platform };
      }
    }
    
    // Secondary check: SSRF protection via ALLOWED_HOSTS
    if (ALLOWED_HOSTS.has(hostname)) {
      // Extract platform name from hostname
      const platformMatch = hostname.match(/^(?:api\.)?([^.]+)/);
      return { compatible: true, platform: platformMatch?.[1] || hostname };
    }
    
    return { 
      compatible: false, 
      platform: null, 
      error: `Unsupported source platform: ${hostname}` 
    };
  } catch (e: unknown) {
    return { compatible: false, platform: null, error: 'Invalid URL format' };
  }
}

export async function GET(req: NextRequest) {
  try {
    const user = await getMiddlewareUser();

    if (!user) {
      throw new ApiError('Unauthorized', 401, ErrorCodes.UNAUTHORIZED);
    }

    if (!await checkRateLimit(`library-get:${user.id}`, 60, 60000)) {
      throw new ApiError('Too many requests. Please wait a moment.', 429, ErrorCodes.RATE_LIMITED);
    }

    const { searchParams } = new URL(req.url);
    const parsed = LibraryQuerySchema.safeParse(Object.fromEntries(searchParams));
    
    if (!parsed.success) {
      throw new ApiError(parsed.error.errors[0].message, 400, ErrorCodes.VALIDATION_ERROR);
    }
    
      const { q, status, sort, limit, offset } = parsed.data;

    // PERF-3: Check Redis cache before hitting DB
    let version = await redisApi.get(libraryVersionKey(user.id)).catch(() => null);
    if (!version) {
      version = '1';
      await redisApi.set(libraryVersionKey(user.id), version).catch(() => {});
    }
    const cacheParams = `v${version}:${q || ''}:${status || ''}:${sort}:${limit}:${offset}`;
    const cacheKey = libraryCacheKey(user.id, cacheParams);
    const cached = await redisApi.get(cacheKey).catch(() => null);
    if (cached) {
      try {
        return NextResponse.json(JSON.parse(cached));
      } catch {
        logger.warn('[Library] Corrupted cache entry, fetching fresh data');
      }
    }

    const where: any = {
      user_id: user.id,
    };

    if (status) {
      where.status = status;
    }

    if (q) {
      where.Series = {
        title: {
          contains: escapeILikePattern(q),
          mode: 'insensitive',
        },
      };
    }

    const orderBy: any = {};
    if (sort === 'title') {
      orderBy.Series = { title: 'asc' };
    } else if (sort === 'rating') {
      orderBy.user_rating = { sort: 'desc', nulls: 'last' };
    } else if (sort === 'added') {
      orderBy.created_at = 'desc';
    } else if (sort === 'latest_chapter') {
      orderBy.Series = { last_chapter_date: 'desc' };
    } else {
      orderBy.updated_at = 'desc';
    }

      // Use read replica for read-only queries (falls back to primary if no replica configured)
      const [items, filteredTotal, statusCounts] = await Promise.all([
        prismaRead.libraryEntry.findMany({
        where,
        select: {
          id: true,
          series_id: true,
          status: true,
          metadata_status: true,
          // Bug 9: Include sync_status for UX clarity
          sync_status: true,
          last_sync_at: true,
          needs_review: true,
          source_url: true,
          imported_title: true,
          last_read_chapter: true,
          user_rating: true,
          updated_at: true,
          Series: {
            select: {
              id: true,
              title: true,
              cover_url: true,
              type: true,
              status: true,
              content_rating: true,
            },
          },
        },
        orderBy,
        take: limit,
        skip: offset,
      }),
        prismaRead.libraryEntry.count({ where }),
        prismaRead.libraryEntry.groupBy({
        by: ['status'],
        where: { user_id: user.id },
        _count: true,
      }),
    ]);

    const stats = {
      all: statusCounts.reduce((acc, curr) => acc + curr._count, 0),
      reading: statusCounts.find(c => c.status === 'reading')?._count || 0,
      completed: statusCounts.find(c => c.status === 'completed')?._count || 0,
      planning: statusCounts.find(c => c.status === 'planning')?._count || 0,
      dropped: statusCounts.find(c => c.status === 'dropped')?._count || 0,
      paused: statusCounts.find(c => c.status === 'paused')?._count || 0,
      };
  
      const responseData = {
          entries: sanitizePrismaObject(items),
          stats,
        pagination: {
          total: filteredTotal,
          limit,
          offset,
          hasMore: offset + items.length < filteredTotal,
        },
      };

      // PERF-3: Cache the response
      try {
        await redisApi.set(cacheKey, JSON.stringify(responseData), 'EX', LIBRARY_CACHE_TTL);
      } catch (cacheError: unknown) {
        logger.warn('[Library] Failed to cache response', { error: cacheError instanceof Error ? cacheError.message : String(cacheError) });
      }

      return NextResponse.json(responseData);
  } catch (error: unknown) {
    return handleApiError(error);
  }
}

/**
 * POST /api/library
 * Add a series to user's library
 * 
 * RESPONSE CONTRACT:
 * - xpGained: base XP only (NOT including achievement XP) - always 0 for series_added
 * - achievements: array of unlocked achievements (empty if none)
 * 
 * v5 Audit Bugs Fixed:
 * - Bug 15: Check duplicate source binding
 * - Bug 16: Verify platform compatibility
 */
export async function POST(req: NextRequest) {
  try {
    const user = await getMiddlewareUser();

    if (!user) {
      throw new ApiError('Unauthorized', 401, ErrorCodes.UNAUTHORIZED);
    }

    // CSRF Protection
    validateOrigin(req);

    // BUG 58: Validate Content-Type
    validateContentType(req);

    // BUG 57: Validate JSON Size
    await validateJsonSize(req);

    if (!await checkRateLimit(`library-add:${user.id}`, 30, 60000)) {
      throw new ApiError('Too many requests. Please wait a moment.', 429, ErrorCodes.RATE_LIMITED);
    }

    let body;
    try {
      body = await req.json();
    } catch {
      throw new ApiError('Invalid JSON body', 400, ErrorCodes.BAD_REQUEST);
    }
    
    const validatedBody = AddToLibrarySchema.safeParse(body);
    if (!validatedBody.success) {
      throw new ApiError(validatedBody.error.errors[0].message, 400, ErrorCodes.VALIDATION_ERROR);
    }

    const { seriesId, status } = validatedBody.data;

      // Check if series exists and get its primary source
      const series = await prisma.series.findUnique({
        where: { id: seriesId },
        include: { 
          SeriesSource: {
            take: 1,
            orderBy: { trust_score: 'desc' }
          } 
        }
      });

      if (!series) {
        throw new ApiError('Series not found', 404, ErrorCodes.NOT_FOUND);
      }

      const primarySource = series.SeriesSource[0];
    if (!primarySource) {
      throw new ApiError('Series has no associated sources. Cannot add to library.', 400, ErrorCodes.BAD_REQUEST);
    }

    // v5 Audit Bug 16: Verify platform compatibility
    const platformCheck = verifyPlatformCompatibility(primarySource.source_url);
    if (!platformCheck.compatible) {
      throw new ApiError(
        platformCheck.error || 'Unsupported source platform',
        400,
        ErrorCodes.VALIDATION_ERROR
      );
    }

    // v5 Audit Bug 15: Check for duplicate source binding
    // Check if user already has an entry with the same source URL
    const existingBySource = await prisma.libraryEntry.findUnique({
      where: {
        user_id_source_url: {
          user_id: user.id,
          source_url: primarySource.source_url,
        }
      },
      select: { id: true, series_id: true, deleted_at: true }
    });

    if (existingBySource && !existingBySource.deleted_at) {
      // Entry already exists for this source URL
      if (existingBySource.series_id === seriesId) {
        // Same series - just return success (idempotent)
        const existingEntry = await prisma.libraryEntry.findUnique({
          where: { id: existingBySource.id }
        });
        return NextResponse.json(existingEntry, { status: 200 });
      } else {
        // Different series with same source - this is a conflict
        throw new ApiError(
          'You already have this source URL in your library linked to a different series',
          409,
          ErrorCodes.CONFLICT
        );
      }
    }

    // Also check if user already has this series (by series_id)
      const existingBySeries = await prisma.libraryEntry.findFirst({
        where: {
          user_id: user.id,
          series_id: seriesId,
        },
        select: { id: true, source_url: true }
      });

    if (existingBySeries) {
      // Already tracking this series (possibly via different source)
      // Return existing entry (idempotent)
      const existingEntry = await prisma.libraryEntry.findUnique({
        where: { id: existingBySeries.id }
      });
      return NextResponse.json(existingEntry, { status: 200 });
    }

      // Create/Update library entry and increment follow count atomically
          const result = await prisma.$transaction(async (tx) => {
            const existingEntry = await tx.libraryEntry.findUnique({
              where: {
                user_id_source_url: {
                  user_id: user.id,
                  source_url: primarySource.source_url,
                }
              },
              select: { id: true, deleted_at: true }
            });

            const entry = await tx.libraryEntry.upsert({
              where: {
                user_id_source_url: {
                  user_id: user.id,
                  source_url: primarySource.source_url,
                }
              },
              update: {
                series_id: seriesId,
                status: status,
                deleted_at: null, // Restore if soft-deleted
                // NOTE: Do NOT reset last_read_chapter - preserve progress on re-add
              },
              create: {
                user_id: user.id,
                series_id: seriesId,
                source_url: primarySource.source_url,
                source_name: primarySource.source_name,
                status: status,
                last_read_chapter: 0, // Only set to 0 for NEW entries
                metadata_status: 'enriched',
                // Bug 9: Initialize sync_status
                sync_status: 'healthy',
              }
            });

            // Increment follow count if NEW entry OR restored from soft-delete
            let shouldPromote = false;
            let isNewEntry = false;
            if (!existingEntry || existingEntry.deleted_at) {
              await tx.series.update({
                where: { id: seriesId },
                data: { total_follows: { increment: 1 } }
              });
              
              shouldPromote = true;
              isNewEntry = true;
            }

            // Check achievements for series_added trigger (only on new/restored entries)
            // XP is awarded internally by checkAchievements
            const unlockedAchievements: UnlockedAchievement[] = [];
            if (isNewEntry) {
              try {
                const achievements = await checkAchievements(tx, user.id, 'series_added');
                unlockedAchievements.push(...achievements);
              } catch (achievementError: unknown) {
                  logger.error('Failed to check achievements:', { error: achievementError instanceof Error ? achievementError.message : String(achievementError) });
              }
            }

            return { entry, shouldPromote, unlockedAchievements };
          }, DEFAULT_TX_OPTIONS);

      // MANGATRACK PARITY: Promote series tier on follow - Outside transaction to avoid deadlocks
      if (result.shouldPromote) {
        await promoteSeriesTier(seriesId, 'user_follow');
      }
      
      const entry = result.entry;
    
      // Log the event (Audit Logging enhancement)
    await logSecurityEvent({
      userId: user.id,
      event: 'LIBRARY_ADD',
      status: 'success',
      ipAddress: getClientIp(req),
      userAgent: req.headers.get('user-agent'),
      metadata: { series_id: seriesId, status }
    })

    // PERF-3: Invalidate library cache on mutation
    await invalidateLibraryCache(user.id);

    // Build response following mandatory contract
    // series_added doesn't award base XP, only achievement XP (handled internally)
    const response: Record<string, unknown> = { ...entry };
    
    if (result.unlockedAchievements.length > 0) {
      response.xpGained = 0;  // No base XP for series_added
      response.achievements = result.unlockedAchievements.map(a => ({
        code: a.code,
        name: a.name,
        xp_reward: a.xp_reward,
        rarity: a.rarity,
      }));
    }

    return NextResponse.json(response, { status: 201 });

  } catch (error: unknown) {
      logger.error('Library add error:', { error: error instanceof Error ? error.message : String(error) });
    return handleApiError(error);
  }
}
