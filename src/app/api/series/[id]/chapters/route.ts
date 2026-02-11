import { prisma, withRetry } from "@/lib/prisma"
import { NextRequest, NextResponse } from "next/server"
import { checkRateLimit, getClientIp, handleApiError, ApiError, ErrorCodes, validateUUID, getMiddlewareUser } from "@/lib/api-utils"
import { scrapers } from "@/lib/scrapers"
import { Prisma } from "@prisma/client"
import { syncChapters } from "@/lib/series-sync"
import { getUserSourcePreferences } from "@/lib/source-utils"
import { sortSourcesWithPreferences } from "@/lib/source-utils-shared"
import { logger } from "@/lib/logger"

// v2.2.1 - Optimized N+1 query for source metadata

function safeParseInt(value: string | null, defaultValue: number, min: number, max: number): number {
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) return defaultValue;
  return Math.min(max, Math.max(min, parsed));
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ip = getClientIp(request);
    if (!await checkRateLimit(`chapters:${ip}`, 60, 60000)) {
      throw new ApiError("Too many requests. Please wait a moment.", 429, ErrorCodes.RATE_LIMITED);
    }

    const { id: seriesId } = await params
    const { searchParams } = new URL(request.url)
    const sourceFilter = searchParams.get("source")
    const sortBy = searchParams.get("sort") || "chapter_desc"
    
    const page = safeParseInt(searchParams.get("page"), 1, 1, 10000)
    const limit = safeParseInt(searchParams.get("limit"), 50, 1, 100)
    const grouped = searchParams.get("grouped") !== "false"

    validateUUID(seriesId, 'series ID')

    // N+1 Optimization: Pre-fetch all series sources
    const seriesSources = await prisma.seriesSource.findMany({
      where: { series_id: seriesId },
      select: {
        id: true,
        source_name: true,
        source_id: true,
        trust_score: true,
      }
    })
    const sourceMap = new Map(seriesSources.map(s => [s.id, s]))

    const user = await getMiddlewareUser();

    // 1. Initial Fetch
    let { total, chapters } = await fetchChapters(seriesId, {
      sourceFilter,
      sortBy,
      page,
      limit,
      grouped,
      sourceMap
    });

    // 2. On-demand Sync (If empty and first page)
    if (total === 0 && page === 1) {
      await performOnDemandSync(seriesId);
      
      // Re-fetch sourceMap in case new sources were added during sync
      const updatedSources = await prisma.seriesSource.findMany({
        where: { series_id: seriesId },
        select: { id: true, source_name: true, source_id: true, trust_score: true }
      })
      const updatedSourceMap = new Map(updatedSources.map(s => [s.id, s]))

      // Re-fetch after sync
      const refreshed = await fetchChapters(seriesId, {
        sourceFilter,
        sortBy,
        page,
        limit,
        grouped,
        sourceMap: updatedSourceMap
      });
      total = refreshed.total;
      chapters = refreshed.chapters;
    }

    // 3. User Read Status and Source Preferences
    let readChapterIds: Set<string> = new Set()
    let lastReadChapter: number = -1
    let sourcePreferences: any = { globalPriorities: new Map() }

      if (user) {
        const [readChapters, libraryEntry, prefs] = await Promise.all([
          prisma.userChapterReadV2.findMany({
            where: {
              user_id: user.id,
              LogicalChapter: { series_id: seriesId },
            },
            select: { chapter_id: true },
          }),
          prisma.libraryEntry.findFirst({
            where: {
              user_id: user.id,
              series_id: seriesId,
            },
            select: { last_read_chapter: true },
          }),
          getUserSourcePreferences(user.id, seriesId),
        ])

      readChapterIds = new Set(readChapters.map(r => r.chapter_id))
      lastReadChapter = libraryEntry?.last_read_chapter ? Number(libraryEntry.last_read_chapter) : -1
      sourcePreferences = prefs
    }

    // 4. Formatting and Formatting Sources
    const formattedChapters = chapters.map((c: any) => {
      const num = Number(c.chapter_number);
      const logicalId = grouped ? c.id : c.chapter_id;
      const isRead = readChapterIds.has(logicalId) || 
        (lastReadChapter >= 0 && !isNaN(num) && num <= lastReadChapter);
      
      const sources = grouped ? (c.sources || []) : [{
        id: c.id,
        source_name: c.source_name,
        source_id: c.source_id,
        chapter_url: c.source_url,
        trust_score: c.trust_score,
        is_available: c.is_available,
        published_at: c.published_at,
        detected_at: c.detected_at
      }];

      const sortedSources = sortSourcesWithPreferences(sources, sourcePreferences);
      
      if (grouped) {
        return {
          ...c,
          chapter_number: num,
          is_read: isRead,
          sources: sortedSources,
          latest_upload: c.published_at?.toISOString() || c.first_detected_at?.toISOString() || null,
        };
      } else {
        const topSource = sortedSources[0] || sources[0];
        return {
          ...c,
          chapter_number: num,
          is_read: isRead,
          source_name: topSource?.source_name,
          source_url: topSource?.chapter_url || topSource?.source_url,
          trust_score: topSource?.trust_score,
        };
      }
    });

    return NextResponse.json({
      chapters: formattedChapters,
      total,
      page,
      limit,
      total_pages: Math.ceil(total / limit),
      grouped,
    })
  } catch (error: unknown) {
    return handleApiError(error);
  }
}

async function fetchChapters(seriesId: string, options: any) {
  const { sourceFilter, sortBy, page, limit, grouped, sourceMap } = options;
  const skip = (page - 1) * limit;

  if (grouped) {
    const logicalWhere: Prisma.LogicalChapterWhereInput = { 
      series_id: seriesId,
      deleted_at: null
    }
    const total = await prisma.logicalChapter.count({ where: logicalWhere })
  
    const chaptersList = await withRetry(() => 
      prisma.logicalChapter.findMany({
        where: logicalWhere,
        orderBy: sortBy === "discovered_desc" 
          ? { first_seen_at: "desc" }
          : sortBy === "published_desc"
          ? { published_at: "desc" }
          : { chapter_number: "desc" },
        take: limit,
        skip,
          include: {
            ChapterSource: {
              where: sourceFilter ? {
                SeriesSource: { source_name: sourceFilter }
              } : undefined,
              // Removed nested include for series_source to eliminate N+1
              select: {
                id: true,
                series_source_id: true,
                source_chapter_url: true,
                source_published_at: true,
                detected_at: true,
                is_available: true,
              }
            },
          },
        })
      )

      return {
        total,
        chapters: chaptersList.map(lc => ({
          id: lc.id,
          chapter_number: Number(lc.chapter_number),
          chapter_title: lc.chapter_title,
          volume_number: lc.volume_number,
          published_at: lc.published_at,
          first_detected_at: lc.first_seen_at,
          sources: lc.ChapterSource.map(s => {
            const sourceMeta = sourceMap.get(s.series_source_id);
            return {
              id: s.id,
              source_name: sourceMeta?.source_name || "unknown",
              source_id: sourceMeta?.source_id || "",
              chapter_url: s.source_chapter_url,
              published_at: s.source_published_at?.toISOString() || null,
              detected_at: s.detected_at.toISOString(),
              is_available: s.is_available,
              trust_score: sourceMeta ? Number(sourceMeta.trust_score) : 0,
            };
          }),
        }))
      };
    } else {
      const sourceWhere: Prisma.ChapterSourceWhereInput = {
        LogicalChapter: { 
          series_id: seriesId,
          deleted_at: null
        },
        SeriesSource: sourceFilter ? { source_name: sourceFilter } : undefined
      }

      const total = await prisma.chapterSource.count({ where: sourceWhere })

      const chapterSources = await withRetry(() =>
        prisma.chapterSource.findMany({
          where: sourceWhere,
          orderBy: sortBy === "discovered_desc"
            ? { detected_at: "desc" }
            : sortBy === "published_desc"
            ? { source_published_at: "desc" }
            : { LogicalChapter: { chapter_number: "desc" } },
          take: limit,
          skip,
          include: {
            LogicalChapter: {
              select: {
                id: true,
                chapter_number: true,
                chapter_title: true,
                volume_number: true,
              }
            }
            // Removed nested include for series_source to eliminate N+1
          }
        })
      )

      return {
        total,
        chapters: chapterSources.map(s => {
          const sourceMeta = sourceMap.get(s.series_source_id);
          return {
            id: s.id,
            chapter_id: s.LogicalChapter.id,
            chapter_number: Number(s.LogicalChapter.chapter_number),
            chapter_title: s.chapter_title || s.LogicalChapter.chapter_title,
            volume_number: s.LogicalChapter.volume_number,
            chapter_url: s.source_chapter_url,
            published_at: s.source_published_at?.toISOString() || null,
            detected_at: s.detected_at.toISOString(),
            is_available: s.is_available,
            source_name: sourceMeta?.source_name || "unknown",
          source_id: sourceMeta?.source_id || "",
          trust_score: sourceMeta ? Number(sourceMeta.trust_score) : 0,
        };
      })
    };
  }
}

async function performOnDemandSync(seriesId: string) {
  const lockId = parseInt(seriesId.replace(/-/g, '').substring(0, 8), 16)
  
  if (isNaN(lockId)) {
    logger.error(`[Sync] Invalid lock ID for series ${seriesId}`);
    return;
  }
  
  try {
    const lockAcquired = await prisma.$queryRaw<{ pg_try_advisory_lock: boolean }[]>`SELECT pg_try_advisory_lock(${lockId})`;

    if (!lockAcquired || lockAcquired.length === 0 || !lockAcquired[0]?.pg_try_advisory_lock) {
        logger.info(`[Sync] Series ${seriesId} is already being synced or lock failed, skipping.`);
      return;
    }

    try {
        const [currentCount, sourceCount] = await Promise.all([
          prisma.logicalChapter.count({ 
            where: { 
              series_id: seriesId,
              deleted_at: null
            } 
          }),
          prisma.chapterSource.count({
            where: {
              LogicalChapter: { 
                series_id: seriesId,
                deleted_at: null
              }
            }
          })
        ]);
      
        const series = await prisma.series.findUnique({
          where: { id: seriesId },
          include: { SeriesSource: true }
        });

        if (!series) return;

        let syncSource = series.SeriesSource.find((s: any) => s.source_name === 'mangadex') || series.SeriesSource[0];
      
      if (!syncSource && series.mangadex_id) {
        syncSource = await prisma.seriesSource.upsert({
          where: {
            source_name_source_id: {
              source_name: 'mangadex',
              source_id: series.mangadex_id
            }
          },
          update: { series_id: seriesId },
          create: {
            series_id: seriesId,
            source_name: 'mangadex',
            source_id: series.mangadex_id,
            source_url: `https://mangadex.org/title/${series.mangadex_id}`,
            source_title: series.title,
            sync_priority: 'COLD'
          }
        });
      }

      if (!syncSource) return;

      let isDummy = false;
      if (currentCount === 3) {
        // FIX: Use logicalChapter instead of chapter
        const existingChapters = await prisma.logicalChapter.findMany({
          where: { series_id: seriesId, deleted_at: null },
          select: { chapter_title: true }
        });
        const dummyTitles = ["The Beginning", "The Journey", "New Discovery"];
        isDummy = existingChapters.every(c => dummyTitles.includes(c.chapter_title || ""));
      }

      const hasOrphanedChapters = currentCount > 0 && sourceCount === 0;
      
      if (currentCount > 0 && !isDummy && !hasOrphanedChapters) {
        return;
      }

      if (scrapers[syncSource.source_name]) {
        const scraped = await scrapers[syncSource.source_name].scrapeSeries(syncSource.source_id);
        
        if (scraped.chapters.length > 0) {
          await syncChapters(seriesId, syncSource.source_id, syncSource.source_name, scraped.chapters);
        }
      }
    } finally {
      await prisma.$queryRaw`SELECT pg_advisory_unlock(${lockId})`.catch(err => {
          logger.error(`[Sync] Failed to release lock for ${seriesId}:`, { error: err instanceof Error ? err.message : String(err) });
        });
      }
    } catch (err: unknown) {
      logger.error(`[Sync] On-demand sync failed for ${seriesId}:`, { error: err instanceof Error ? err.message : String(err) });
    }
  }
