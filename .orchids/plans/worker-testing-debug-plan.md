# Worker Testing & Debugging Plan

## Overview
This document outlines the comprehensive testing strategy for MangaTrack's BullMQ worker system.

## Worker Architecture Summary

### 18 Active Workers
| Worker | Queue | Purpose | Concurrency |
|--------|-------|---------|-------------|
| Canonicalize | canonicalize | Series deduplication | Config-based |
| PollSource | sync-source | Poll MangaDex for updates | 10 req/s limiter |
| ChapterIngest | chapter-ingest | Process new chapters | Config-based |
| CheckSource | check-source | Verify source availability | 3 req/s limiter |
| Notification | notification | Create notifications | Config-based |
| NotificationDelivery | notification-delivery | Send notifications | Config-based |
| NotificationDeliveryPremium | notification-delivery-premium | Priority notifications | 1000/min limiter |
| NotificationDigest | notification-digest | Batch digest emails | Config-based |
| RefreshCover | refresh-cover | Update series covers | 5 req/s limiter |
| GapRecovery | gap-recovery | Fill missing chapters | Config-based |
| Resolution | series-resolution | Metadata enrichment | 5 req/s limiter |
| Import | import | Library import jobs | Config-based |
| FeedFanout | feed-fanout | Distribute feed entries | Config-based |
| LatestFeed | latest-feed | Update feed cache | Config-based |
| NotificationTiming | notification-timing | Schedule notifications | Config-based |
| MangadexStatsRefresh | mangadex-stats-refresh | Update series stats | 1 |
| FeedIngest | feed-ingest | Ingest chapter releases | 2 |
| ReleaseLinker | release-linker | Link MU releases to series | 1 |

### 14 Schedulers in Master Scheduler
1. **Priority maintenance** - Promote/demote sync priorities
2. **Cover refresh scheduler** - Queue cover updates
3. **Deferred search scheduler** - Process queued searches
4. **Notification digest scheduler** - Batch notifications
5. **Safety monitor** - Health checks
6. **Cleanup scheduler** - Remove old data
7. **Tier maintenance scheduler** - Update catalog tiers
8. **Latest feed scheduler** - Refresh feeds
9. **Notification timing scheduler** - Queue timed notifications
10. **Recommendations scheduler** - Generate recommendations
11. **Trust score decay scheduler** - Decay source trust
12. **Metadata healing scheduler** - Fix failed metadata
13. **MangaDex stats refresh scheduler** - Refresh series statistics
14. **Feed ingest scheduler** - Poll for new releases

## Testing Strategy

### 1. Infrastructure Health Check
```bash
# Check Redis connectivity
redis-cli ping

# Check worker heartbeat
redis-cli GET "mangatrack:development:workers:heartbeat"

# Check queue depths
redis-cli LLEN "bull:sync-source:wait"
redis-cli LLEN "bull:chapter-ingest:wait"
```

### 2. Queue Status Verification
Query each queue for:
- Waiting jobs count
- Active jobs count
- Completed jobs count
- Failed jobs count
- Delayed jobs count

### 3. Worker Simulation Tests

#### Test 1: Release Linker Worker
```typescript
// Add a test job to release-linker queue
await releaseLinkQueue.add('test-link', { batchSize: 10, dryRun: true });
// Expected: Job completes, logs show "DRY RUN" entries
```

#### Test 2: Feed Ingest Worker
```typescript
// Trigger feed ingest for tier A
await feedIngestQueue.add('test-ingest', { source: 'mangadex', tier: 'A', limit: 10 });
// Expected: Fetches chapters from MangaDex API
```

#### Test 3: Resolution Worker
```typescript
// Queue a metadata resolution job
await seriesResolutionQueue.add('test-resolution', { libraryEntryId: 'test-uuid' });
// Expected: Attempts MangaDex search for the entry
```

### 4. Scheduler Verification
The master scheduler runs every 5 minutes. To verify:
1. Check `mangatrack:development:scheduler:run_history` in Redis
2. Verify `last_run_at` in scheduler watermark
3. Check job counts in sync-source queue after scheduler run

### 5. Error Handling Tests

#### DLQ (Dead Letter Queue) Test
```typescript
// Force a job failure
await syncSourceQueue.add('fail-test', { seriesSourceId: 'invalid-uuid' });
// Expected: After retries exhausted, job moves to DLQ
```

#### Circuit Breaker Test
```typescript
// Simulate external API failure
// Workers should back off and not overwhelm failed services
```

### 6. Metrics Verification

#### Release Linker Metrics
```bash
# Check Redis hash for metrics
redis-cli HGETALL "mangatrack:development:metrics:release-linker"
# Expected fields: total_linked, total_errors, last_run_at, success_rate
```

## Database State Checks

### Series with MangaUpdates IDs
```sql
SELECT COUNT(*) FROM series WHERE mangaupdates_series_id IS NOT NULL;
```

### Linked Releases
```sql
SELECT COUNT(*) FROM mangaupdates_releases WHERE series_id IS NOT NULL;
```

### Pending Metadata Resolution
```sql
SELECT COUNT(*) FROM library_entries WHERE metadata_status = 'pending';
```

## Monitoring Commands

### Worker Health
```bash
# Check if workers are running
curl http://localhost:3000/api/health/workers

# Check queue health
curl http://localhost:3000/api/health/queues
```

### Job Statistics
```bash
# Get queue job counts
curl http://localhost:3000/api/admin/queues/stats
```

## Expected Behavior

### Normal Operation
1. Master scheduler runs every 5 minutes
2. Scheduler acquires lock, runs all sub-schedulers
3. Jobs are queued based on tier priorities (A > B > C)
4. Workers process jobs with rate limiting
5. Heartbeat sent every 10 seconds
6. Metrics updated after each job

### Failure Scenarios
1. **Redis unavailable**: Workers exit after 3 failed pings
2. **Job failure**: Retry with exponential backoff, then DLQ
3. **Scheduler crash**: Watermark allows recovery detection
4. **Lock contention**: Exponential backoff for lock acquisition

## Current Status (Feb 2026)

### Known Working
- TypeScript compilation: 0 errors in production code
- API tests: 20/20 passing
- Release linker: Metrics tracking implemented
- Feed ingest: MangaDex and MangaUpdates polling

### Areas to Monitor
- Auth timeouts (Supabase connectivity in sandbox)
- DNS resolution fallbacks for MangaDex CDN
- Queue depth during high activity periods

## Simulation Procedure

### Manual Job Injection
```typescript
// From Node REPL or script
import { syncSourceQueue, seriesResolutionQueue, feedIngestQueue } from '@/lib/queues';

// Test sync source
await syncSourceQueue.add('manual-test', { seriesSourceId: 'existing-source-id' });

// Test resolution
await seriesResolutionQueue.add('manual-test', { libraryEntryId: 'existing-entry-id' });

// Test feed ingest
await feedIngestQueue.add('manual-test', { source: 'mangadex', tier: 'A', limit: 5 });
```

### Queue Inspection
```bash
# List waiting jobs
redis-cli LRANGE "bull:sync-source:wait" 0 -1

# Get job data
redis-cli HGETALL "bull:sync-source:job-id"
```

## Conclusion

The worker system is designed with:
- Graceful shutdown handlers
- Error accumulation without halting
- Watermark-based crash recovery
- Rate limiting for external APIs
- DLQ for permanent failures
- Comprehensive metrics tracking

Testing should focus on:
1. Job completion verification
2. Error handling behavior
3. Rate limit compliance
4. Scheduler coordination
5. Metrics accuracy
