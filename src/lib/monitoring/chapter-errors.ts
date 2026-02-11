/**
 * Chapter Error Monitoring
 * 
 * Tracks "Chapter Not Found" errors to detect issues after the
 * chapter table consolidation migration (Feb 2026).
 * 
 * Usage:
 *   import { trackChapterNotFound, getChapterErrorStats } from '@/lib/monitoring/chapter-errors';
 *   
 *   // When a chapter lookup fails
 *   trackChapterNotFound({ seriesId, chapterId, chapterNumber, source: 'api' });
 *   
 *   // Get stats for monitoring dashboard
 *   const stats = getChapterErrorStats();
 */

import { logger } from '@/lib/logger';

interface ChapterNotFoundEvent {
  seriesId?: string;
  chapterId?: string;
  chapterNumber?: string | number;
  chapterSlug?: string;
  source: 'api' | 'worker' | 'feed' | 'progress' | 'link-submission';
  userId?: string;
  timestamp?: Date;
  additionalContext?: Record<string, unknown>;
}

interface ChapterErrorStats {
  totalErrors: number;
  errorsLast5Min: number;
  errorsLast1Hour: number;
  errorsLast24Hours: number;
  errorsBySource: Record<string, number>;
  recentErrors: Array<ChapterNotFoundEvent & { timestamp: Date }>;
  firstErrorAt: Date | null;
  lastErrorAt: Date | null;
}

// In-memory storage for error tracking (resets on server restart)
// For production, consider using Redis or a database table
const errorEvents: Array<ChapterNotFoundEvent & { timestamp: Date }> = [];
const MAX_STORED_EVENTS = 1000;

/**
 * Track a "Chapter Not Found" error
 */
export function trackChapterNotFound(event: ChapterNotFoundEvent): void {
  const timestamp = event.timestamp || new Date();
  
  const enrichedEvent = {
    ...event,
    timestamp,
  };
  
  // Log for observability
  logger.warn('Chapter Not Found error detected', {
    seriesId: event.seriesId,
    chapterId: event.chapterId,
    chapterNumber: event.chapterNumber?.toString(),
    chapterSlug: event.chapterSlug,
    source: event.source,
    userId: event.userId,
  });
  
  // Store in memory
  errorEvents.push(enrichedEvent);
  
  // Trim old events to prevent memory leaks
  if (errorEvents.length > MAX_STORED_EVENTS) {
    errorEvents.splice(0, errorEvents.length - MAX_STORED_EVENTS);
  }
  
  // Alert if error rate is high
  const last5MinErrors = getErrorCountSince(5 * 60 * 1000);
  if (last5MinErrors >= 10) {
    logger.error('HIGH CHAPTER ERROR RATE ALERT', {
      errorsLast5Min: last5MinErrors,
      source: event.source,
    });
  }
}

/**
 * Get count of errors since a given time offset
 */
function getErrorCountSince(msAgo: number): number {
  const cutoff = Date.now() - msAgo;
  return errorEvents.filter(e => e.timestamp.getTime() > cutoff).length;
}

/**
 * Get chapter error statistics for monitoring
 */
export function getChapterErrorStats(): ChapterErrorStats {
  const now = Date.now();
  const fiveMinAgo = now - 5 * 60 * 1000;
  const oneHourAgo = now - 60 * 60 * 1000;
  const oneDayAgo = now - 24 * 60 * 60 * 1000;
  
  const errorsBySource: Record<string, number> = {};
  
  for (const event of errorEvents) {
    errorsBySource[event.source] = (errorsBySource[event.source] || 0) + 1;
  }
  
  return {
    totalErrors: errorEvents.length,
    errorsLast5Min: errorEvents.filter(e => e.timestamp.getTime() > fiveMinAgo).length,
    errorsLast1Hour: errorEvents.filter(e => e.timestamp.getTime() > oneHourAgo).length,
    errorsLast24Hours: errorEvents.filter(e => e.timestamp.getTime() > oneDayAgo).length,
    errorsBySource,
    recentErrors: errorEvents.slice(-20).reverse(),
    firstErrorAt: errorEvents.length > 0 ? errorEvents[0].timestamp : null,
    lastErrorAt: errorEvents.length > 0 ? errorEvents[errorEvents.length - 1].timestamp : null,
  };
}

/**
 * Clear error history (for testing)
 */
export function clearChapterErrorHistory(): void {
  errorEvents.length = 0;
}

/**
 * Check if chapter error monitoring is healthy
 * Returns false if error rate is too high
 */
export function isChapterMonitoringHealthy(): { healthy: boolean; reason?: string } {
  const stats = getChapterErrorStats();
  
  // Alert thresholds
  if (stats.errorsLast5Min >= 20) {
    return {
      healthy: false,
      reason: `Critical: ${stats.errorsLast5Min} chapter errors in last 5 minutes`,
    };
  }
  
  if (stats.errorsLast1Hour >= 100) {
    return {
      healthy: false,
      reason: `Warning: ${stats.errorsLast1Hour} chapter errors in last hour`,
    };
  }
  
  return { healthy: true };
}
