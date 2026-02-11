import { Job } from 'bullmq';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { redisApi, REDIS_KEY_PREFIX } from '@/lib/redis';

/**
 * Release Linker Processor
 * 
 * Links MangaUpdates releases to local series records.
 * This enables the ReleaseInfoCard to display "Available On" metadata.
 * 
 * The matching is done by:
 * 1. Finding releases without a series_id
 * 2. Matching them to local series by mangaupdates_series_id
 * 3. Updating the release's series_id foreign key (in batches for performance)
 */

interface ReleaseLinkJobData {
  batchSize?: number;
  dryRun?: boolean;
}

interface ReleaseLinkResult {
  linked: number;
  skipped: number;
  errors: number;
}

// Metrics keys
const METRICS_KEY = `${REDIS_KEY_PREFIX}metrics:release-linker`;

/**
 * Update release linker metrics in Redis
 */
async function updateMetrics(result: ReleaseLinkResult, durationMs: number): Promise<void> {
  try {
    const pipeline = redisApi.pipeline();
    
    // Increment total counts
    pipeline.hincrby(METRICS_KEY, 'total_linked', result.linked);
    pipeline.hincrby(METRICS_KEY, 'total_skipped', result.skipped);
    pipeline.hincrby(METRICS_KEY, 'total_errors', result.errors);
    pipeline.hincrby(METRICS_KEY, 'total_runs', 1);
    
    // Track last run stats
    pipeline.hset(METRICS_KEY, 'last_run_linked', result.linked);
    pipeline.hset(METRICS_KEY, 'last_run_skipped', result.skipped);
    pipeline.hset(METRICS_KEY, 'last_run_errors', result.errors);
    pipeline.hset(METRICS_KEY, 'last_run_duration_ms', durationMs);
    pipeline.hset(METRICS_KEY, 'last_run_at', new Date().toISOString());
    
    // Calculate success rate
    const totalAttempted = result.linked + result.errors;
    if (totalAttempted > 0) {
      const successRate = Math.round((result.linked / totalAttempted) * 100);
      pipeline.hset(METRICS_KEY, 'last_run_success_rate', successRate);
    }
    
    await pipeline.exec();
  } catch (e: unknown) {
    logger.warn('[ReleaseLinkWorker] Failed to update metrics', { error: e });
  }
}

/**
 * Get release linker metrics
 */
export async function getReleaseLinkMetrics(): Promise<Record<string, string | number>> {
  try {
    const metrics = await redisApi.hgetall(METRICS_KEY);
    return metrics || {};
  } catch (e: unknown) {
    logger.warn('[ReleaseLinkWorker] Failed to get metrics', { error: e });
    return {};
  }
}

export async function processReleaseLink(job: Job<ReleaseLinkJobData>): Promise<ReleaseLinkResult> {
  const { batchSize = 100, dryRun = false } = job.data || {};
  const startTime = Date.now();
  
  logger.info(`[ReleaseLinkWorker] Starting release linking job`, {
    jobId: job.id,
    batchSize,
    dryRun
  });
  
  try {
    // 1. Get all series that have MangaUpdates IDs
    const seriesWithMuId = await prisma.series.findMany({
      where: {
        mangaupdates_series_id: { not: null }
      },
      select: {
        id: true,
        mangaupdates_series_id: true,
        title: true
      }
    });
    
    if (seriesWithMuId.length === 0) {
      logger.info(`[ReleaseLinkWorker] No series have MangaUpdates IDs yet`);
      return { linked: 0, skipped: 0, errors: 0 };
    }
    
    // Create a map for fast lookup: MU series ID -> local series ID
    const muIdToSeriesId = new Map<bigint, string>();
    for (const s of seriesWithMuId) {
      if (s.mangaupdates_series_id) {
        muIdToSeriesId.set(s.mangaupdates_series_id, s.id);
      }
    }
    
    logger.info(`[ReleaseLinkWorker] Found ${seriesWithMuId.length} series with MangaUpdates IDs`);
    
    // 2. Get unlinked releases that match our series
    const muIds = Array.from(muIdToSeriesId.keys());
    const unlinkedReleases = await prisma.mangaUpdatesRelease.findMany({
      where: {
        series_id: null,
        mangaupdates_series_id: { in: muIds }
      },
      select: {
        id: true,
        mangaupdates_series_id: true,
        title: true
      },
      take: batchSize
    });
    
    if (unlinkedReleases.length === 0) {
      logger.info(`[ReleaseLinkWorker] No unlinked releases to process`);
      return { linked: 0, skipped: 0, errors: 0 };
    }
    
    logger.info(`[ReleaseLinkWorker] Found ${unlinkedReleases.length} unlinked releases to process`);
    
    // 3. Group releases by target series_id for batch updates
    const releasesBySeriesId = new Map<string, string[]>();
    let skipped = 0;
    
    for (const release of unlinkedReleases) {
      const localSeriesId = muIdToSeriesId.get(release.mangaupdates_series_id);
      
      if (!localSeriesId) {
        skipped++;
        continue;
      }
      
      const existing = releasesBySeriesId.get(localSeriesId) || [];
      existing.push(release.id);
      releasesBySeriesId.set(localSeriesId, existing);
    }
    
    if (dryRun) {
      let dryRunLinked = 0;
      for (const [seriesId, releaseIds] of releasesBySeriesId) {
        logger.debug(`[ReleaseLinkWorker] [DRY RUN] Would link ${releaseIds.length} releases to series ${seriesId}`);
        dryRunLinked += releaseIds.length;
      }
      return { linked: dryRunLinked, skipped, errors: 0 };
    }
    
    // 4. Perform batch updates using updateMany for better performance
    let linked = 0;
    let errors = 0;
    
    for (const [seriesId, releaseIds] of releasesBySeriesId) {
      try {
        const result = await prisma.mangaUpdatesRelease.updateMany({
          where: {
            id: { in: releaseIds },
            series_id: null // Safety check - don't overwrite existing links
          },
          data: { series_id: seriesId }
        });
        linked += result.count;
      } catch (error: unknown) {
        logger.warn(`[ReleaseLinkWorker] Failed to link ${releaseIds.length} releases to series ${seriesId}`, {
          error: error instanceof Error ? error.message : String(error)
        });
        errors += releaseIds.length;
      }
    }
    
    const duration = Date.now() - startTime;
    logger.info(`[ReleaseLinkWorker] Completed release linking`, {
      linked,
      skipped,
      errors,
      durationMs: duration,
      dryRun
    });
    
    const result = { linked, skipped, errors };
    
    // Update metrics (non-blocking)
    if (!dryRun) {
      updateMetrics(result, duration).catch(() => {});
    }
    
    return result;
    
  } catch (error: unknown) {
    const duration = Date.now() - startTime;
    logger.error(`[ReleaseLinkWorker] Failed to process release linking`, {
      jobId: job.id,
      durationMs: duration,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}
