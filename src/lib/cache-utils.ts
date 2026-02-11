import { redisApi, REDIS_KEY_PREFIX } from '@/lib/redis';
import { logger } from '@/lib/logger';

/**
 * Get the Redis key for a user's library version counter.
 * Used for cache invalidation and versioned cache reads.
 */
export function libraryVersionKey(userId: string): string {
  return `${REDIS_KEY_PREFIX}library:v:${userId}`;
}

/**
 * Invalidate the library cache for a user by bumping the version counter.
 * Used across library routes to ensure stale data is not served.
 */
export async function invalidateLibraryCache(userId: string): Promise<void> {
  try {
    await redisApi.incr(libraryVersionKey(userId));
  } catch (e: unknown) {
    logger.warn('[Library] Failed to invalidate cache', { error: e instanceof Error ? e.message : String(e) });
  }
}
