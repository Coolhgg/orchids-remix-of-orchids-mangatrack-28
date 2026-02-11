import { prisma, withRetry } from "@/lib/prisma"
import { NextRequest, NextResponse } from "next/server"
import {
  checkRateLimit,
  getClientIp,
  handleApiError,
  ApiError,
  ErrorCodes,
  getMiddlewareUser,
  validateUUID,
} from "@/lib/api-utils"
import { logger } from "@/lib/logger"
import { recordSignal } from "@/lib/analytics/signals"

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ip = getClientIp(request);
    if (!await checkRateLimit(`series:${ip}`, 60, 60000)) {
      throw new ApiError("Too many requests. Please wait a moment.", 429, ErrorCodes.RATE_LIMITED)
    }

    const { id } = await params

    validateUUID(id, 'series ID')

    const user = await getMiddlewareUser()

      const series = await withRetry(() =>
        prisma.series.findUnique({
          where: { id, deleted_at: null },
          include: {
            SeriesSource: {
              orderBy: { trust_score: "desc" },
            },
            SeriesCreator: {
              include: {
                Creator: true,
              },
            },
            SeriesStat: true,
            series_relations_series_relations_series_idToseries: {
              include: {
                series_series_relations_related_idToseries: {
                  select: {
                    id: true,
                    title: true,
                    cover_url: true,
                    type: true,
                    status: true,
                    last_chapter_at: true,
                  },
                },
              },
            },
          },
        })
      )

    if (!series) {
      throw new ApiError("Series not found", 404, ErrorCodes.NOT_FOUND)
    }

    // Record manga_click signal for authenticated users (non-blocking)
    if (user) {
      recordSignal({
        user_id: user.id,
        series_id: id,
        signal_type: 'manga_click',
        metadata: { source: 'series_page' }
      }).catch(err => logger.error('[Series] Failed to record signal:', { error: err instanceof Error ? err.message : String(err) }));
    }

    let libraryEntry = null
    let userProgress = null

    if (user) {
      libraryEntry = await prisma.libraryEntry.findFirst({
        where: {
          user_id: user.id,
          series_id: id,
          deleted_at: null, // BUG FIX: Respect soft delete
        },
      })

          if (libraryEntry) {
          // Use UserChapterReadV2 which has LogicalChapter relation
          const readChapters = await prisma.userChapterReadV2.findMany({
                where: {
                  user_id: user.id,
                  LogicalChapter: {
                    series_id: id,
                  },
                },
                select: {
                  chapter_id: true,
                  LogicalChapter: {
                    select: {
                      chapter_number: true,
                    },
                  },
                },
              })

            userProgress = {
              status: libraryEntry.status,
              last_read_chapter: libraryEntry.last_read_chapter ? Number(libraryEntry.last_read_chapter) : null,
              preferred_source: libraryEntry.preferred_source,
              user_rating: libraryEntry.user_rating,
              chapters_read: readChapters.map((r) => ({
                chapter_id: r.chapter_id,
                chapter_number: r.LogicalChapter?.chapter_number ? Number(r.LogicalChapter.chapter_number) : null,
              })),
            }
        }
    }

      // Get chapter stats per source through ChapterSource model
      const chapterSourceStats = await prisma.chapterSource.groupBy({
        by: ["series_source_id"],
        where: { 
          LogicalChapter: { series_id: id, deleted_at: null }
        },
        _count: { id: true },
      });

      // Get max chapter number per source
      const sourceChapterMaxes = await prisma.chapterSource.findMany({
        where: { 
          LogicalChapter: { series_id: id, deleted_at: null }
        },
        select: {
          series_source_id: true,
          LogicalChapter: {
            select: { chapter_number: true }
          }
        }
      });

      // Build a map of source -> max chapter number
      const sourceMaxChapters = new Map<string, string>();
        for (const sc of sourceChapterMaxes) {
          const current = sourceMaxChapters.get(sc.series_source_id);
          const chNum = sc.LogicalChapter?.chapter_number;
          if (chNum && (!current || parseFloat(chNum) > parseFloat(current))) {
            sourceMaxChapters.set(sc.series_source_id, chNum);
          }
        }

    // FIX: Use LogicalChapter instead of Chapter for counts and latest chapter
    const totalChapters = await prisma.logicalChapter.count({
      where: { series_id: id, deleted_at: null },
    })

    const latestChapter = await prisma.logicalChapter.findFirst({
      where: { series_id: id, deleted_at: null },
      orderBy: { chapter_number: "desc" },
      select: { chapter_number: true, published_at: true },
    })

      const sourcesWithStats = series.SeriesSource.map((source: typeof series.SeriesSource[0]) => {
        const stats = chapterSourceStats.find(c => c.series_source_id === source.id)
        const maxChapterNum = sourceMaxChapters.get(source.id)
        return {
          id: source.id,
          source_name: source.source_name,
          source_url: source.source_url,
          source_title: source.source_title,
          trust_score: Number(source.trust_score),
          chapter_count: stats?._count.id || 0,
          latest_chapter: maxChapterNum ? Number(maxChapterNum) : null,
          last_success_at: source.last_success_at?.toISOString() || null,
          cover_url: source.cover_url,
        }
      })

      const authors = series.SeriesCreator
        .filter((sc: typeof series.SeriesCreator[0]) => sc.role === "author")
        .map((sc: typeof series.SeriesCreator[0]) => ({ id: sc.Creator.id, name: sc.Creator.name }))
      const artists = series.SeriesCreator
        .filter((sc: typeof series.SeriesCreator[0]) => sc.role === "artist")
        .map((sc: typeof series.SeriesCreator[0]) => ({ id: sc.Creator.id, name: sc.Creator.name }))

      const relatedSeries = series.series_relations_series_relations_series_idToseries.map((r: typeof series.series_relations_series_relations_series_idToseries[0]) => ({
        id: r.series_series_relations_related_idToseries.id,
        title: r.series_series_relations_related_idToseries.title,
        cover_url: r.series_series_relations_related_idToseries.cover_url,
        type: r.series_series_relations_related_idToseries.type,
        status: r.series_series_relations_related_idToseries.status,
        relation_type: r.relation_type,
        last_chapter_at: r.series_series_relations_related_idToseries.last_chapter_at,
      }))

    return NextResponse.json({
      id: series.id,
      mangadex_id: series.mangadex_id,
      title: series.title,
      alternative_titles: series.alternative_titles,
      description: series.description,
      cover_url: series.cover_url,
      type: series.type,
      status: series.status,
      genres: series.genres,
      tags: series.tags,
      themes: series.themes,
      format_tags: series.format_tags,
      demographic: series.demographic,
      content_rating: series.content_rating,
      content_warnings: series.content_warnings,
      original_language: series.original_language,
      translated_languages: series.translated_languages,
      year: series.year || series.release_year,
      external_links: series.external_links,
      authors,
      artists,
        sources: sourcesWithStats,
        related_series: relatedSeries,
        stats: series.SeriesStat ? {
          total_readers: series.SeriesStat.total_readers,
          readers_reading: series.SeriesStat.readers_reading,
          readers_completed: series.SeriesStat.readers_completed,
          readers_planning: series.SeriesStat.readers_planning,
          readers_dropped: series.SeriesStat.readers_dropped,
          readers_on_hold: series.SeriesStat.readers_on_hold,
          total_ratings: series.SeriesStat.total_ratings,
          rating_distribution: {
            1: series.SeriesStat.rating_1,
            2: series.SeriesStat.rating_2,
            3: series.SeriesStat.rating_3,
            4: series.SeriesStat.rating_4,
            5: series.SeriesStat.rating_5,
            6: series.SeriesStat.rating_6,
            7: series.SeriesStat.rating_7,
            8: series.SeriesStat.rating_8,
            9: series.SeriesStat.rating_9,
            10: series.SeriesStat.rating_10,
          },
          popularity_rank: series.SeriesStat.popularity_rank,
          trending_rank: series.SeriesStat.trending_rank,
        } : null,
      total_chapters: totalChapters,
      latest_chapter: latestChapter ? Number(latestChapter.chapter_number) : null,
      last_chapter_at: latestChapter?.published_at?.toISOString() || series.last_chapter_at?.toISOString() || null,
      total_follows: series.total_follows,
      total_views: series.total_views,
      average_rating: series.average_rating ? Number(series.average_rating) : null,
      user_progress: userProgress,
      in_library: !!libraryEntry,
      created_at: series.created_at.toISOString(),
      updated_at: series.updated_at.toISOString(),
    })
  } catch (error: unknown) {
    // BUG FIX: Use centralized error handler for consistency
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2023') {
      return handleApiError(new ApiError("Invalid series ID format", 400, ErrorCodes.VALIDATION_ERROR))
    }
    
    return handleApiError(error)
  }
}
