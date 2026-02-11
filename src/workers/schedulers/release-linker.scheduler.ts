import { Queue } from 'bullmq';
import { redis } from '@/lib/redis';
import { logger } from '@/lib/logger';

/**
 * Release Linker Scheduler
 * 
 * Schedules periodic jobs to link MangaUpdates releases to local series.
 * Runs every hour to catch newly enriched series.
 */

const QUEUE_NAME = 'release-linker';
const SCHEDULE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

let releaseLinkQueue: Queue | null = null;

export function getReleaseLinkQueue(): Queue {
  if (!releaseLinkQueue) {
    releaseLinkQueue = new Queue(QUEUE_NAME, {
      connection: redis,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
      },
    });
  }
  return releaseLinkQueue;
}

export async function startReleaseLinkScheduler() {
  const queue = getReleaseLinkQueue();
  
  // Remove any existing repeatable jobs
  const existingJobs = await queue.getRepeatableJobs();
  for (const job of existingJobs) {
    await queue.removeRepeatableByKey(job.key);
  }
  
  // Add a new repeatable job
  await queue.add(
    'link-releases',
    { batchSize: 500 },
    {
      repeat: {
        every: SCHEDULE_INTERVAL_MS,
      },
      jobId: 'scheduled-release-link',
    }
  );
  
  // Also run immediately on startup
  await queue.add(
    'link-releases-immediate',
    { batchSize: 500 },
    {
      jobId: `immediate-release-link-${Date.now()}`,
    }
  );
  
  logger.info(`[ReleaseLinkScheduler] Started with ${SCHEDULE_INTERVAL_MS / 1000}s interval`);
}

export async function stopReleaseLinkScheduler() {
  if (releaseLinkQueue) {
    const existingJobs = await releaseLinkQueue.getRepeatableJobs();
    for (const job of existingJobs) {
      await releaseLinkQueue.removeRepeatableByKey(job.key);
    }
    await releaseLinkQueue.close();
    releaseLinkQueue = null;
    logger.info(`[ReleaseLinkScheduler] Stopped`);
  }
}
