import { prisma } from './prisma';
import { CatalogTier } from '@prisma/client';
import { calculateDecayedScore } from './series-scoring';
import { logger } from './logger';

// Activity weights (MangaTrack Parity / Anti-Ban Design)
export const ACTIVITY_WEIGHTS = {
  chapter_detected: 1,      // New chapter found by scraper
  chapter_source_added: 2,  // New translation source available
  search_impression: 5,     // Series appeared in search results
  chapter_read: 50,         // User opened a chapter
  series_followed: 100,     // User added series to library
} as const;

export type ActivityEventType = keyof typeof ACTIVITY_WEIGHTS | 'inactivity_decay';

// Thresholds for tier promotion
export const TIER_THRESHOLDS = {
  A: {
    recentChapterDays: 30,      // Chapter in last 30 days
    minActivityScore: 5000,     // 5k points (e.g. 100 reads or 1k impressions)
    minFollowers: 10,           // OR 10+ followers
  },
  B: {
    minActivityScore: 1000,     // Requires 1,000 points (e.g. 20 reads or 200 impressions)
    minFollowers: 1,            // OR at least 1 follower
  }
} as const;

// ========================================
// PERF-03: Debounced search impression buffer
// Collects search_impression events and flushes them in bulk
// instead of firing 5+ DB queries per series per search.
// ========================================
const SEARCH_IMPRESSION_FLUSH_INTERVAL_MS = 10_000; // 10 seconds
const pendingSearchImpressions = new Map<string, number>(); // seriesId → impression count
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Queue a search impression for batched processing.
 * Instead of immediately running 5+ DB queries per series,
 * we buffer impressions and flush them every 10 seconds.
 */
function queueSearchImpression(seriesId: string): void {
  pendingSearchImpressions.set(seriesId, (pendingSearchImpressions.get(seriesId) || 0) + 1);

  // Start flush timer if not already running
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushSearchImpressions().catch(err => {
        logger.error(`[TierManager] Failed to flush search impressions: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, SEARCH_IMPRESSION_FLUSH_INTERVAL_MS);
  }
}

/**
 * Flush all pending search impressions in a single batch.
 * Deduplicates series (only processes each series once per flush),
 * inserts activity events in bulk, and evaluates tiers for unique series.
 */
async function flushSearchImpressions(): Promise<void> {
  flushTimer = null;
  
  if (pendingSearchImpressions.size === 0) return;
  
  // Snapshot and clear the buffer atomically
  const batch = new Map(pendingSearchImpressions);
  pendingSearchImpressions.clear();
  
  const seriesIds = Array.from(batch.keys());
  const weight = ACTIVITY_WEIGHTS.search_impression;
  
  logger.info(`[TierManager] Flushing ${seriesIds.length} search impressions (from ${Array.from(batch.values()).reduce((a, b) => a + b, 0)} total events)`);
  
  try {
    // 1. Bulk insert activity events — one per unique series (not per duplicate impression)
    // This collapses e.g. 5 searches for the same series into 1 event row
    // SECURITY: Validate UUIDs before inserting to prevent injection via $executeRawUnsafe
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const validSeriesIds = seriesIds.filter(id => uuidRegex.test(id));
    
    // Insert in chunks to avoid query size limits
    const CHUNK_SIZE = 100;
    for (let i = 0; i < validSeriesIds.length; i += CHUNK_SIZE) {
      const chunk = validSeriesIds.slice(i, i + CHUNK_SIZE);
      const values = chunk.map(id => `('${id}'::uuid, NULL::uuid, NULL::uuid, NULL, 'search_impression', ${weight})`);
      await prisma.$executeRawUnsafe(`
        INSERT INTO activity_events (series_id, chapter_id, user_id, source_name, event_type, weight)
        VALUES ${values.join(', ')}
      `);
    }
    
    // 2. Bulk update last_activity_at for all affected series
    await prisma.series.updateMany({
      where: { id: { in: seriesIds } },
      data: { last_activity_at: new Date() }
    });
    
    // 3. Refresh scores and evaluate tiers — batch with limited concurrency
    const CONCURRENCY = 5;
    for (let i = 0; i < seriesIds.length; i += CONCURRENCY) {
      const chunk = seriesIds.slice(i, i + CONCURRENCY);
      await Promise.allSettled(chunk.map(id => refreshActivityScore(id)));
    }
  } catch (err: unknown) {
    logger.error(`[TierManager] Batch flush error: ${err instanceof Error ? err.message : String(err)}`);
    // Re-queue failed items for next flush
    for (const [id, count] of batch) {
      pendingSearchImpressions.set(id, (pendingSearchImpressions.get(id) || 0) + count);
    }
    // Schedule retry
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushSearchImpressions().catch(() => {});
      }, SEARCH_IMPRESSION_FLUSH_INTERVAL_MS * 2);
    }
  }
}

/**
 * Record an activity event for a series (source-agnostic)
 * SECURITY: Uses parameterized query to prevent SQL injection.
 */
export async function recordActivityEvent(
  seriesId: string,
  eventType: ActivityEventType,
  sourceName?: string,
  chapterId?: string,
  userId?: string
): Promise<void> {
  const weight = eventType === 'inactivity_decay' ? 0 : (ACTIVITY_WEIGHTS[eventType as keyof typeof ACTIVITY_WEIGHTS] || 0);
  
  // 1. Create activity event in the new canonical table
  // SECURITY: Use tagged template literal for parameterized query to prevent SQL injection
  await prisma.$executeRaw`
    INSERT INTO activity_events (series_id, chapter_id, user_id, source_name, event_type, weight)
    VALUES (${seriesId}::uuid, ${chapterId || null}::uuid, ${userId || null}::uuid, ${sourceName || null}, ${eventType}, ${weight})
  `;
  
  // 2. Update last_activity_at (if not a decay event)
  if (eventType !== 'inactivity_decay') {
    await prisma.series.update({
      where: { id: seriesId },
      data: { last_activity_at: new Date() }
    });
  }

  // 3. Refresh the score using the exact formula
  await refreshActivityScore(seriesId);
}

/**
 * Evaluate if a series should be promoted based on activity
 * CRITICAL: Source-agnostic - never checks MangaDex existence
 */
export async function evaluateTierPromotion(seriesId: string): Promise<CatalogTier> {
  const series = await prisma.series.findUnique({
    where: { id: seriesId },
    include: {
      SeriesStat: true,
      SeedListEntry: { 
        where: { SeedList: { is_active: true } },
        include: { SeedList: true } 
      },
      LogicalChapter: {
        where: {
          first_seen_at: {
            gte: new Date(Date.now() - TIER_THRESHOLDS.A.recentChapterDays * 24 * 60 * 60 * 1000)
          }
        },
        take: 1,
      }
    }
  });
  
  if (!series) return 'C';
  
  const currentTier = series.catalog_tier ?? 'C';
  let newTier: CatalogTier = currentTier;
  let reason = series.tier_reason;
  
  // ========================================
  // TIER A CONDITIONS (any ONE is sufficient)
  // ========================================
  
  // 1. Recent chapter from ANY source
  if (series.LogicalChapter.length > 0) {
    newTier = 'A';
    reason = 'recent_chapter';
  }
  
  // 2. High activity score
  else if ((series.activity_score ?? 0) >= TIER_THRESHOLDS.A.minActivityScore) {
    newTier = 'A';
    reason = 'high_engagement';
  }
  
  // 3. Many followers
  else if (series.SeriesStat && series.SeriesStat.total_readers >= TIER_THRESHOLDS.A.minFollowers) {
    newTier = 'A';
    reason = 'popular';
  }
  
  // 4. In active seed list
  else if (series.SeedListEntry.length > 0) {
    newTier = 'A';
    reason = 'seed_list';
  }
  
    // ========================================
    // TIER B CONDITIONS (user-relevant)
    // ========================================
    else if (newTier === 'C' && (
      (series.activity_score ?? 0) >= TIER_THRESHOLDS.B.minActivityScore || 
      (series.SeriesStat && series.SeriesStat.total_readers >= TIER_THRESHOLDS.B.minFollowers)
    )) {
      newTier = 'B';
      reason = 'user_relevant';
    }
  
  // ========================================
  // Apply tier change if needed
  // ========================================
  if (newTier !== currentTier) {
    await prisma.series.update({
      where: { id: seriesId },
      data: {
        catalog_tier: newTier,
        tier_promoted_at: new Date(),
        tier_reason: reason,
      }
    });
    
    logger.info(`[TierManager] Series ${seriesId} promoted: ${currentTier} → ${newTier} (reason: ${reason})`);
  }
  
  return newTier;
}

/**
 * Legacy support for promoteSeriesTier
 * PERF-03: search_impression events are now debounced via an in-memory buffer
 * to avoid firing 5+ DB queries per series per search request.
 */
export async function promoteSeriesTier(
  seriesId: string, 
  reason: 'chapter_first_appearance' | 'chapter_detected' | 'user_search' | 'user_follow' | 'activity'
) {
  // PERF-03: Debounce search impressions — queue instead of immediate processing
  if (reason === 'user_search') {
    queueSearchImpression(seriesId);
    return;
  }

  let eventType: ActivityEventType = 'chapter_detected';
  if (reason === 'chapter_first_appearance') eventType = 'chapter_detected';
  if (reason === 'chapter_detected') eventType = 'chapter_source_added';
  if (reason === 'user_follow') eventType = 'series_followed';
  
  await recordActivityEvent(seriesId, eventType);
}

/**
 * Refresh activity score based on aggregated data and decay logic
 */
export async function refreshActivityScore(seriesId: string) {
  const series = await prisma.series.findUnique({
    where: { id: seriesId },
    include: { SeriesStat: true }
  });

  if (!series) return;

  // Use the new decay-adjusted scoring formula
  const score = calculateDecayedScore(series);
  
  await prisma.series.update({
    where: { id: seriesId },
    data: { activity_score: score }
  });
  
  await evaluateTierPromotion(seriesId);
}

/**
 * Demote stale series and apply inactivity decay (run periodically)
 * Formula: -5 per week of inactivity
 */
export async function runTierDemotionCheck(): Promise<void> {
  // 1. Identify series that need decay or demotion
  const staleCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // 1 week
  
  const affectedSeries = await prisma.series.findMany({
    where: {
      OR: [
        { activity_score: { gt: 0 }, last_activity_at: { lt: staleCutoff } },
        { catalog_tier: { in: ['A', 'B'] }, last_activity_at: { lt: staleCutoff } }
      ]
    },
    select: { id: true }
  });

  for (const series of affectedSeries) {
    await refreshActivityScore(series.id);
  }

  // 2. Legacy demotion logic for hard cutoffs (optional if refreshActivityScore + evaluateTierPromotion is robust)
  const hardStaleCutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  await prisma.series.updateMany({
      where: {
        catalog_tier: 'A',
        last_activity_at: { lt: hardStaleCutoff },
        SeedListEntry: { none: {} },
      },
    data: {
      catalog_tier: 'B',
      tier_reason: 'stale_demoted',
    }
  });
}
