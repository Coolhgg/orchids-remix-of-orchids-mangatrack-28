import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { handleApiError, ApiError, ErrorCodes, validateContentType, validateJsonSize, validateOrigin, checkRateLimit, getClientIp, getMiddlewareUser } from '@/lib/api-utils';
import { z } from 'zod';
import { Prisma } from '@prisma/client';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const syncActionSchema = z.object({
  id: z.string(),
  type: z.enum(['LIBRARY_UPDATE', 'CHAPTER_READ', 'SETTING_UPDATE', 'LIBRARY_DELETE', 'LIBRARY_ADD']),
  payload: z.any(),
  timestamp: z.number(),
  deviceId: z.string(),
});

const syncBatchSchema = z.object({
  actions: z.array(syncActionSchema).max(100), // Limit batch size to prevent abuse
});

/**
 * POST /api/sync/replay
 * Replays a batch of sync actions from a device outbox.
 * Implements LWW conflict resolution for read states.
 */
export async function POST(req: NextRequest) {
  try {
    // CSRF Protection
    validateOrigin(req);
    
    // Content validation
    validateContentType(req);
    await validateJsonSize(req, 2 * 1024 * 1024);

    // Rate limiting: 20 sync replay requests per minute per IP
    const ip = getClientIp(req);
    if (!await checkRateLimit(`sync-replay:${ip}`, 20, 60000)) {
      throw new ApiError('Too many requests. Please wait a moment.', 429, ErrorCodes.RATE_LIMITED);
    }

    const user = await getMiddlewareUser();
    if (!user) {
      throw new ApiError('Unauthorized', 401, ErrorCodes.UNAUTHORIZED);
    }

    // Additional user-based rate limiting to prevent abuse
    if (!await checkRateLimit(`sync-replay:user:${user.id}`, 30, 60000)) {
      throw new ApiError('Too many sync requests. Please wait a moment.', 429, ErrorCodes.RATE_LIMITED);
    }

    let body;
    try {
      body = await req.json();
    } catch {
      throw new ApiError('Invalid JSON body', 400, ErrorCodes.BAD_REQUEST);
    }
    const validatedData = syncBatchSchema.safeParse(body);
    if (!validatedData.success) {
      throw new ApiError(validatedData.error.errors[0].message, 400, ErrorCodes.VALIDATION_ERROR);
    }

    const { actions } = validatedData.data;
      const results: Array<{ id: string; status: string; message?: string; applied?: boolean }> = [];

      // Optimization: Process actions in a single transaction if possible
      // or at least optimize the loop to avoid redundant series lookups
      await prisma.$transaction(async (tx) => {
        for (const action of actions) {
          try {
            if (action.type === 'CHAPTER_READ') {
              const { entryId, chapterNumber, chapterSlug, sourceId, isRead = true } = action.payload;
              const targetTimestamp = new Date(action.timestamp);

              const entry = await tx.libraryEntry.findUnique({
                where: { id: entryId, user_id: user.id },
                select: { series_id: true }
              });

              if (!entry) {
                results.push({ id: action.id, status: 'error', message: 'Library entry not found' });
                continue;
              }

              // MANGATRACK PARITY: Logical chapters are identified strictly by (series_id, chapter_number)
              const NO_NUMBER_SENTINEL = new Prisma.Decimal(-1);
              const chapterNumDecimal = chapterNumber !== undefined && chapterNumber !== null 
                ? new Prisma.Decimal(chapterNumber) 
                : NO_NUMBER_SENTINEL;
              const chapterNumString = chapterNumDecimal.toString();

              const chapter = await tx.logicalChapter.findUnique({
                  where: {
                    series_id_chapter_number: {
                      series_id: entry.series_id || "",
                      chapter_number: chapterNumString,
                    }
                  },
                  select: { id: true }
                });

              if (chapter) {
                // Validate sourceId as UUID before casting to prevent transaction-killing SQL errors
                const safeSourceId = (sourceId && UUID_RE.test(sourceId)) ? sourceId : null;

                const updateResult = await tx.$executeRaw`
                  INSERT INTO "user_chapter_reads_v2" 
                    ("id", "user_id", "chapter_id", "is_read", "updated_at", "read_at", "source_used_id", "device_id", "server_received_at")
                  VALUES 
                    (gen_random_uuid(), ${user.id}::uuid, ${chapter.id}::uuid, ${isRead}, ${targetTimestamp}::timestamptz, ${targetTimestamp}::timestamptz, ${safeSourceId}::uuid, ${action.deviceId}, NOW())
                ON CONFLICT ("user_id", "chapter_id")
                DO UPDATE SET 
                  "is_read" = EXCLUDED."is_read",
                  "updated_at" = EXCLUDED."updated_at",
                  "device_id" = EXCLUDED."device_id",
                  "server_received_at" = EXCLUDED."server_received_at",
                  "read_at" = CASE WHEN EXCLUDED."is_read" = true THEN EXCLUDED."updated_at" ELSE "user_chapter_reads_v2"."read_at" END,
                  "source_used_id" = EXCLUDED."source_used_id"
                WHERE EXCLUDED."updated_at" > "user_chapter_reads_v2"."updated_at"
                   OR (EXCLUDED."updated_at" = "user_chapter_reads_v2"."updated_at" 
                       AND EXCLUDED."server_received_at" < "user_chapter_reads_v2"."server_received_at")
              `;

              results.push({ id: action.id, status: 'success', applied: updateResult > 0 });
            } else {
               results.push({ id: action.id, status: 'error', message: 'Logical chapter not found' });
            }
          } else if (action.type === 'LIBRARY_UPDATE') {
            const { entryId, status, rating, notes } = action.payload;
            const targetTimestamp = new Date(action.timestamp);

            const updateResult = await tx.libraryEntry.updateMany({
              where: { 
                id: entryId, 
                user_id: user.id,
                updated_at: { lt: targetTimestamp } // LWW
              },
              data: {
                status: status || undefined,
                user_rating: rating !== undefined ? rating : undefined,
                updated_at: targetTimestamp,
              }
            });

            results.push({ id: action.id, status: 'success', applied: updateResult.count > 0 });
          } else {
            results.push({ id: action.id, status: 'skipped', message: `Sync for ${action.type} not yet fully implemented` });
          }
        } catch (err: unknown) {
          results.push({ id: action.id, status: 'error', message: err instanceof Error ? err.message : 'Internal error' });
        }
      }
    }, {
      timeout: 15000 // 15s timeout for batch processing
    });

    return NextResponse.json({ results });
  } catch (error: unknown) {
    return handleApiError(error);
  }
}
