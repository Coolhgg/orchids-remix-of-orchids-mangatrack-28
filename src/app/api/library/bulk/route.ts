import { NextRequest, NextResponse } from 'next/server';
import { prisma, DEFAULT_TX_OPTIONS } from '@/lib/prisma';
import { logActivity } from '@/lib/gamification/activity';
import { XP_SERIES_COMPLETED, calculateLevel } from '@/lib/gamification/xp';
import { checkAchievements } from '@/lib/gamification/achievements';
import { checkRateLimit, handleApiError, ApiError, validateOrigin, ErrorCodes, getClientIp, validateContentType, validateJsonSize, getMiddlewareUser } from '@/lib/api-utils';
import { redisApi, REDIS_KEY_PREFIX } from '@/lib/redis';
import { logger } from '@/lib/logger';
import { invalidateLibraryCache } from '@/lib/cache-utils';

export async function PATCH(req: NextRequest) {
  try {
    validateOrigin(req);
    validateContentType(req);
    await validateJsonSize(req);

    const ip = getClientIp(req);
    if (!await checkRateLimit(`library-bulk-update:${ip}`, 10, 60000)) {
      throw new ApiError('Too many requests. Please wait a moment.', 429, ErrorCodes.RATE_LIMITED);
    }

      const user = await getMiddlewareUser();
      if (!user) {
      throw new ApiError('Unauthorized', 401, ErrorCodes.UNAUTHORIZED);
    }

    let body;
    try {
      body = await req.json();
    } catch {
      throw new ApiError('Invalid JSON body', 400, ErrorCodes.BAD_REQUEST);
    }
      if (!body || typeof body !== 'object') {
        throw new ApiError('Invalid JSON body', 400, ErrorCodes.BAD_REQUEST);
      }
      const { updates } = body;

    if (!Array.isArray(updates) || updates.length === 0) {
      throw new ApiError('Updates must be a non-empty array', 400, ErrorCodes.BAD_REQUEST);
    }

    if (updates.length > 50) {
      throw new ApiError('Cannot update more than 50 entries at once', 400, ErrorCodes.BAD_REQUEST);
    }

    const entryIds = updates.map(u => u.id).filter(Boolean);
    const results = await prisma.$transaction(async (tx) => {
        // PERFORMANCE FIX: Fetch all current entries in one query instead of inside the loop
          // SECURITY FIX: Include series_completion_xp_granted to prevent XP farming
          const currentEntries: Array<{
            id: string;
            user_id: string;
            series_id: string | null;
            status: string;
            series_completion_xp_granted?: boolean;
            [key: string]: unknown;
          }> = await tx.libraryEntry.findMany({
            where: { 
              id: { in: entryIds },
              user_id: user.id 
            },
          }) as any;

        const currentEntriesMap = new Map(currentEntries.map(e => [e.id, e]));
      const updatedEntries = [];
      const now = new Date();

      // Collect data for batching side effects
      const completionsToProcess = [];
      const statusUpdatesToProcess = [];

      for (const update of updates) {
        const { id, status, rating, preferred_source } = update;
        if (!id) continue;

        const currentEntry = currentEntriesMap.get(id);
        if (!currentEntry) continue;

        const updateData: any = { updated_at: now };
        if (status) {
          const validStatuses = ['reading', 'completed', 'planning', 'dropped', 'paused'];
          if (validStatuses.includes(status)) {
            updateData.status = status;
          }
        }
        if (rating !== undefined && rating !== null) {
          const ratingNum = Number(rating);
          if (!isNaN(ratingNum) && ratingNum >= 1 && ratingNum <= 10) {
            updateData.user_rating = ratingNum;
          }
        }
        if (preferred_source !== undefined) {
          updateData.preferred_source = preferred_source;
        }

        const updatedEntry = await tx.libraryEntry.update({
          where: { id, user_id: user.id },
          data: updateData,
        });

        updatedEntries.push(updatedEntry);

          // Side effects preparation
          // SECURITY FIX: Check series_completion_xp_granted flag to prevent XP farming
            if (status === 'completed' && currentEntry.status !== 'completed' && !currentEntry.series_completion_xp_granted) {
            completionsToProcess.push(currentEntry);
        } else if (status && status !== currentEntry.status) {
          statusUpdatesToProcess.push({ 
            entry: currentEntry, 
            oldStatus: currentEntry.status, 
            newStatus: status 
          });
        }
      }

        // PERFORMANCE FIX: Batch process completions to avoid N+1 queries
        if (completionsToProcess.length > 0) {
          const seriesIds = completionsToProcess.map(c => c.series_id).filter(Boolean) as string[];
          
          // 1. Check existing activities in one query
          const existingActivities = await tx.activity.findMany({
            where: {
              user_id: user.id,
              series_id: { in: seriesIds },
              type: 'series_completed',
            },
            select: { series_id: true }
          });
          
          const existingSeriesIds = new Set(existingActivities.map(a => a.series_id));
          const newCompletions = completionsToProcess.filter(c => c.series_id && !existingSeriesIds.has(c.series_id));

          if (newCompletions.length > 0) {
            // 2. Fetch user profile once
            const userProfile = await tx.user.findUnique({
              where: { id: user.id },
              select: { xp: true },
            });

            // 3. Calculate total XP gain and update user once
            const totalXpGain = newCompletions.length * XP_SERIES_COMPLETED;
            const newXp = (userProfile?.xp || 0) + totalXpGain;
            const newLevel = calculateLevel(newXp);

            await tx.user.update({
              where: { id: user.id },
              data: { xp: newXp, level: newLevel },
            });

            // 4. PERFORMANCE FIX: Batch log activities and check achievements ONCE
              await tx.activity.createMany({
                data: newCompletions.map(c => ({
                  user_id: user.id,
                  type: 'series_completed',
                  series_id: c.series_id,
                  metadata: {},
                }))
              });

              // SECURITY FIX: Set immutable XP flag to prevent re-farming on bulk updates
              const completionEntryIds = newCompletions.map(c => c.id);
              await tx.libraryEntry.updateMany({
                where: { id: { in: completionEntryIds } },
                data: { series_completion_xp_granted: true },
              });
            
            await checkAchievements(tx, user.id, 'series_completed');
          }
        }

        // Process other status updates
        if (statusUpdatesToProcess.length > 0) {
          await tx.activity.createMany({
            data: statusUpdatesToProcess.map(update => ({
              user_id: user.id,
              type: 'status_updated',
              series_id: update.entry.series_id,
              metadata: { old_status: update.oldStatus, new_status: update.newStatus },
            }))
          });
        }

      return updatedEntries;
      }, { ...DEFAULT_TX_OPTIONS, timeout: 20000 });

      // PERF-3: Invalidate library cache on bulk mutation
      await invalidateLibraryCache(user.id);

      return NextResponse.json({
      success: true,
      count: results.length,
      entries: results
    });
  } catch (error: unknown) {
    return handleApiError(error);
  }
}
