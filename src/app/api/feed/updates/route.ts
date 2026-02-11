import { prisma } from "@/lib/prisma"
import { NextRequest, NextResponse } from "next/server"
import { checkRateLimit, getClientIp, handleApiError, ApiError, ErrorCodes, getMiddlewareUser } from "@/lib/api-utils"
import { PRODUCTION_QUERIES } from "@/lib/sql/production-queries"
import { ALLOWED_CONTENT_RATINGS } from "@/lib/constants/safe-browsing"
import { z } from "zod"

// Input validation schema
const querySchema = z.object({
  cursor: z.string().datetime().optional().nullable(),
  limit: z.coerce.number().min(1).max(50).default(20),
  unseen_only: z.preprocess((val) => val === 'true', z.boolean()).default(false),
});

export async function GET(request: NextRequest) {
  try {
    const ip = getClientIp(request);
    if (!await checkRateLimit(`feed-updates:${ip}`, 60, 60000)) {
      throw new ApiError("Too many requests. Please wait a moment.", 429, ErrorCodes.RATE_LIMITED);
    }

    const user = await getMiddlewareUser();

    if (!user) {
      throw new ApiError("Unauthorized", 401, ErrorCodes.UNAUTHORIZED);
    }

    // Validate query parameters
    const { searchParams } = new URL(request.url);
    const validatedQuery = querySchema.safeParse({
      cursor: searchParams.get("cursor"),
      limit: searchParams.get("limit") || "20",
      unseen_only: searchParams.get("unseen_only"),
    });

    if (!validatedQuery.success) {
      throw new ApiError(validatedQuery.error.errors[0].message, 400, ErrorCodes.VALIDATION_ERROR);
    }

    const { cursor, limit, unseen_only: unseenOnly } = validatedQuery.data;

    // 1. Fetch User Settings
    const userProfile = await prisma.user.findUnique({
      where: { id: user.id },
      select: {
        safe_browsing_mode: true,
        default_source: true,
        feed_last_seen_at: true,
      }
    });

    if (!userProfile) throw new ApiError("User profile not found", 404, ErrorCodes.NOT_FOUND);

    const feedLastSeenAt = userProfile.feed_last_seen_at || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // 2. Fetch Default Filter (for language preference)
    const preferredLanguages: string[] = [];
    // Future: Load from user's saved filter preferences

    // 3. Define Allowed Content Ratings based on safe browsing mode
    // CONTENT POLICY: 'pornographic' is BLOCKED platform-wide and never included
    // EDGE CASE: null safe_browsing_mode defaults to 'sfw' (safe + suggestive only)
    const safeBrowsingMode = userProfile.safe_browsing_mode || 'sfw';
    const allowedRatings = ['safe', 'suggestive'];
    if (safeBrowsingMode === 'suggestive' || safeBrowsingMode === 'sfw_plus') {
      allowedRatings.push('erotica');
    }
    if (safeBrowsingMode === 'nsfw') {
      // NSFW mode includes erotica but NOT pornographic (blocked platform-wide)
      if (!allowedRatings.includes('erotica')) {
        allowedRatings.push('erotica');
      }
    }

    // 4. Build SQL parameters — push cursor/unseen filtering into the query
    const cursorBefore = cursor ? new Date(cursor) : null;
    const unseenAfter = (!cursor && unseenOnly) ? feedLastSeenAt : null;
    const fetchLimit = limit + 1; // +1 for has_more detection

    // 5. Fetch Updates — single query with all filters applied in SQL
    const rawUpdates: any[] = await prisma.$queryRawUnsafe<any[]>(
      PRODUCTION_QUERIES.USER_UPDATES_FEED,
      user.id,
      fetchLimit,
      cursorBefore,
      unseenAfter
    );

    if (rawUpdates.length === 0) {
      return NextResponse.json({ updates: [], next_cursor: null, has_more: false });
    }

    const eligibleSeriesIds = rawUpdates.map(u => u.series_id).filter(Boolean);
    
    // BUG FIX: Handle empty series IDs array
    const libraryEntries = eligibleSeriesIds.length > 0 
      ? await prisma.libraryEntry.findMany({
          where: {
            user_id: user.id,
            series_id: { in: eligibleSeriesIds },
            deleted_at: null
          },
          select: { series_id: true, preferred_source: true }
        })
      : [];
    const preferredSourceMap = new Map(libraryEntries.map(e => [e.series_id, e.preferred_source]));

    // 6. Fetch Full Data for the updates
    const chapterIds = rawUpdates.map(u => u.id).filter(Boolean);
    
    // BUG FIX: Handle empty chapter IDs
    if (chapterIds.length === 0) {
      return NextResponse.json({ updates: [], next_cursor: null, has_more: false });
    }

      // Use LogicalChapter instead of Chapter for update feeds
      const chapters = await prisma.logicalChapter.findMany({
        where: {
          id: { in: chapterIds }
        },
        include: {
          Series: {
            select: {
              id: true,
              title: true,
              cover_url: true,
              content_rating: true,
              status: true
            }
          },
          ChapterSource: {
            where: { 
              is_available: true,
              ...(preferredLanguages.length > 0 && {
                language: { in: preferredLanguages }
              })
            },
            include: {
              SeriesSource: {
                select: {
                  id: true,
                  source_name: true,
                  source_url: true,
                  trust_score: true,
                },
              },
            },
          },
        },
      });

    // 7. Re-sort chapters based on the ranked rawUpdates order
    const chapterMap = new Map(chapters.map(lc => [lc.id, lc]));
    const rankedChapters = rawUpdates.map(raw => 
      chapterMap.get(raw.id)
    ).filter(Boolean) as (typeof chapters[0])[];

    const hasMore = rankedChapters.length > limit;
    const items = hasMore ? rankedChapters.slice(0, limit) : rankedChapters;
    
      // BUG FIX: Safely handle cursor generation with null check
      const lastItem = items.length > 0 ? items[items.length - 1] : null;
      const nextCursor = hasMore && lastItem?.first_seen_at 
        ? lastItem.first_seen_at.toISOString() 
        : null;

      return NextResponse.json({
        updates: items.map((lc) => {
          const seriesPreferredSource = lc.series_id ? preferredSourceMap.get(lc.series_id) : null;
          const globalDefaultSource = userProfile.default_source;
          const preferredSource = seriesPreferredSource || globalDefaultSource;
          
          // Sorting logic for sources within a chapter
          const sortedSources = [...lc.ChapterSource].sort((a, b) => {
            // 1. Preferred source match
            const aIsPreferred = a.SeriesSource.source_name === preferredSource;
            const bIsPreferred = b.SeriesSource.source_name === preferredSource;
            if (aIsPreferred && !bIsPreferred) return -1;
            if (!aIsPreferred && bIsPreferred) return 1;

            // 2. Language match (if multiple preferred languages, first in list)
            if (preferredLanguages.length > 1) {
              const aLangIdx = preferredLanguages.indexOf(a.language || "");
              const bLangIdx = preferredLanguages.indexOf(b.language || "");
              if (aLangIdx !== -1 && bLangIdx !== -1) return aLangIdx - bLangIdx;
              if (aLangIdx !== -1) return -1;
              if (bLangIdx !== -1) return 1;
            }

            // 3. Trust score
            return Number(b.SeriesSource.trust_score) - Number(a.SeriesSource.trust_score);
          });

          const primarySource = sortedSources[0];

          return {
            id: lc.id,
            series: lc.Series,
            chapter_number: Number(lc.chapter_number),
            chapter_title: lc.chapter_title,
            volume_number: lc.volume_number,
            published_at: lc.published_at?.toISOString() || null,
              discovered_at: lc.first_seen_at.toISOString(),
            sources: sortedSources.map(s => ({
              id: s.id,
              chapter_url: s.source_chapter_url,
              scanlation_group: s.scanlation_group,
              language: s.language,
              source: {
                id: s.SeriesSource.id,
                name: s.SeriesSource.source_name,
                url: s.SeriesSource.source_url,
                trust_score: Number(s.SeriesSource.trust_score),
              }
            })),
            primary_source: primarySource ? {
              id: primarySource.id,
              chapter_url: primarySource.source_chapter_url,
              source_name: primarySource.SeriesSource.source_name,
              language: primarySource.language,
              is_preferred: primarySource.SeriesSource.source_name === preferredSource,
              is_fallback: primarySource.SeriesSource.source_name !== preferredSource && !!preferredSource
            } : null
          };
        }),
        next_cursor: nextCursor,
        has_more: hasMore,
      });

  } catch (error: unknown) {
    return handleApiError(error);
  }
}
