# Worker Offline Status - Root Cause Analysis

## Overview

The "worker is offline" message appears in the search API when the system cannot detect active worker processes. This diagnosis identifies the root causes and provides solutions.

## How Worker Status Detection Works

### 1. Heartbeat Mechanism

**Location**: `src/lib/redis.ts` lines 395-427

```typescript
// Workers are considered "online" if:
// 1. Redis is available
// 2. A heartbeat key exists: `mangatrack:{env}:workers:heartbeat`
// 3. The heartbeat timestamp is less than 15 seconds old

export async function areWorkersOnline(): Promise<boolean> {
  const heartbeat = await redisApi.get(`${REDIS_KEY_PREFIX}workers:heartbeat`);
  if (!heartbeat) return false;
  
  const data = JSON.parse(heartbeat);
  const age = Date.now() - data.timestamp;
  return age < 15000;  // 15 seconds threshold
}
```

### 2. Heartbeat Publishing

**Location**: `src/workers/index.ts` lines 461-474

```typescript
// Workers send heartbeat every 10 seconds
// The Redis key expires after 10 seconds (EX 10)
const HEARTBEAT_INTERVAL = 10 * 1000;

await redisApi.set(
  `${REDIS_KEY_PREFIX}workers:heartbeat`, 
  JSON.stringify(payload), 
  'EX', 10  // Expires in 10 seconds
);
```

### 3. Where "Worker Offline" Message Originates

**Location**: `src/app/api/series/search/route.ts` lines 354-425

```typescript
const workersOnline = redisReady && await areWorkersOnline();

if (!workersOnline) {
  // Falls back to synchronous MangaDex search
  skipReason = 'workers_offline';
}
```

---

## Root Causes for "Worker is Offline"

### Cause 1: Worker Process Not Running

**Symptoms**:
- No heartbeat key in Redis
- `areWorkersOnline()` returns `false` immediately

**Verification**:
```bash
# Check if worker process is running
ps aux | grep "workers/index"

# Check Redis for heartbeat
redis-cli GET "mangatrack:development:workers:heartbeat"
# or for production:
redis-cli GET "mangatrack:production:workers:heartbeat"
```

**Solution**: Start the worker process
```bash
bun run src/workers/index.ts
# or via npm script if defined
npm run workers
```

### Cause 2: Redis Connection Issues

**Symptoms**:
- Redis not reachable from worker or API
- `waitForRedis()` times out
- Connection errors in logs

**Verification**:
```bash
# Check Redis is running
redis-cli ping

# Check environment variables
echo $REDIS_URL
echo $REDIS_API_URL
echo $REDIS_WORKER_URL
```

**Solution**: 
- Ensure Redis is running and accessible
- Verify `REDIS_URL` environment variable is set correctly
- Check network connectivity between services

### Cause 3: Worker Stuck Acquiring Global Lock

**Symptoms**:
- Worker logs show "Global lock held by another instance"
- Heartbeat is being sent but worker never becomes "operational"
- Stale lock from crashed worker

**Location**: `src/workers/index.ts` lines 487-509, 561-609

The worker uses a global lock to ensure only one instance runs:
```typescript
const WORKER_GLOBAL_LOCK_KEY = `${REDIS_KEY_PREFIX}workers:global`;
const WORKER_GLOBAL_LOCK_TTL = 60;
```

**Verification**:
```bash
# Check for stale global lock
redis-cli GET "mangatrack:development:workers:global"
redis-cli TTL "mangatrack:development:workers:global"
```

**Solution**:
```bash
# Clear stale lock (safe if no worker is actually running)
redis-cli DEL "mangatrack:development:workers:global"
redis-cli DEL "mangatrack:development:scheduler:lock"
redis-cli DEL "mangatrack:development:lock:scheduler:master"
```

### Cause 4: Heartbeat Key Expired Before Check

**Symptoms**:
- Worker is running
- Intermittent "worker offline" messages
- Race condition between heartbeat TTL (10s) and check threshold (15s)

**Analysis**:
- Heartbeat TTL: 10 seconds
- Check threshold: 15 seconds
- Heartbeat interval: 10 seconds

The timing is tight. If there's any delay in the heartbeat being sent (e.g., Redis latency, GC pause), the key might expire before the next heartbeat.

**Potential Issue**:
```
Timeline:
0s    - Heartbeat sent (expires at 10s)
10s   - Key expires
10.5s - Next heartbeat should be sent (but delayed)
10.2s - API checks areWorkersOnline() -> returns false!
```

### Cause 5: Environment Mismatch

**Symptoms**:
- Worker and API using different Redis key prefixes
- Worker writes to `mangatrack:development:*`
- API reads from `mangatrack:production:*`

**Verification**:
```bash
# Check NODE_ENV in both processes
# Worker
NODE_ENV=development bun run src/workers/index.ts

# API (Next.js)
NODE_ENV=production npm run dev
```

**Solution**: Ensure `NODE_ENV` is consistent across all services.

### Cause 6: Different Redis Instances

**Symptoms**:
- Worker writes heartbeat to one Redis
- API reads from a different Redis
- Caused by different `REDIS_URL` / `REDIS_API_URL` values

**Verification**:
Check if these are different:
```bash
echo "REDIS_URL=$REDIS_URL"
echo "REDIS_API_URL=$REDIS_API_URL"  
echo "REDIS_WORKER_URL=$REDIS_WORKER_URL"
```

**Solution**: Use the same Redis instance for API and workers, or ensure `REDIS_API_URL` is the same for both.

---

## Diagnostic Commands

### 1. Check Worker Process Status
```bash
# Is worker running?
ps aux | grep workers

# Check worker logs
tail -f logs/workers.log
```

### 2. Check Redis Heartbeat
```bash
# For development
redis-cli GET "mangatrack:development:workers:heartbeat"
redis-cli TTL "mangatrack:development:workers:heartbeat"

# For production  
redis-cli GET "mangatrack:production:workers:heartbeat"
redis-cli TTL "mangatrack:production:workers:heartbeat"
```

### 3. Check Global Lock
```bash
redis-cli GET "mangatrack:development:workers:global"
redis-cli TTL "mangatrack:development:workers:global"
```

### 4. Monitor Heartbeat in Real-Time
```bash
# Watch heartbeat key every second
watch -n 1 'redis-cli GET "mangatrack:development:workers:heartbeat" | jq .'
```

### 5. Health Check API
```bash
curl http://localhost:3000/api/health | jq .
```

---

## Recommended Fixes

### Fix 1: Increase Heartbeat TTL (Recommended)

**Problem**: 10-second TTL is too aggressive and causes false positives.

**Solution**: Increase TTL to 30 seconds with 15-second interval.

```typescript
// src/lib/redis.ts - setWorkerHeartbeat
await redisApi.set(`${REDIS_KEY_PREFIX}workers:heartbeat`, JSON.stringify(payload), 'EX', 30);

// src/workers/index.ts
const HEARTBEAT_INTERVAL = 15 * 1000; // 15s interval

// src/lib/redis.ts - areWorkersOnline
const age = Date.now() - data.timestamp;
return age < 45000;  // 45 seconds threshold (3x the interval)
```

### Fix 2: Add Retry Logic to areWorkersOnline

**Problem**: Single check can miss transient issues.

**Solution**: Add retry with backoff.

```typescript
export async function areWorkersOnline(retries = 2): Promise<boolean> {
  for (let i = 0; i <= retries; i++) {
    const redisReady = await waitForRedis(redisApi, 3000);
    if (!redisReady) {
      if (i < retries) {
        await new Promise(r => setTimeout(r, 500));
        continue;
      }
      return false;
    }
    
    try {
      const heartbeat = await redisApi.get(`${REDIS_KEY_PREFIX}workers:heartbeat`);
      if (!heartbeat) {
        if (i < retries) {
          await new Promise(r => setTimeout(r, 500));
          continue;
        }
        return false;
      }
      
      const data = JSON.parse(heartbeat);
      const age = Date.now() - data.timestamp;
      if (age < 45000) return true;
      
      if (i < retries) {
        await new Promise(r => setTimeout(r, 500));
        continue;
      }
    } catch (err) {
      if (i < retries) continue;
      console.error('[Redis] Error checking worker heartbeat:', err);
    }
  }
  return false;
}
```

### Fix 3: Graceful Degradation Already Implemented

The search API already falls back to synchronous MangaDex search when workers are offline:

```typescript
// src/app/api/series/search/route.ts lines 391-424
if (!workersOnline) {
  // SYNCHRONOUS MANGADEX FALLBACK
  const mangadexResults = await searchMangaDex(queryStr || normalizedKey);
  // ... merges results with local
}
```

This is good - the user still gets results, just without background job enqueuing.

---

## Quick Resolution Steps

1. **Check if worker is running**:
   ```bash
   ps aux | grep workers
   ```

2. **If not running, start it**:
   ```bash
   bun run src/workers/index.ts
   ```

3. **If running but still showing offline, clear stale locks**:
   ```bash
   redis-cli DEL "mangatrack:development:workers:global"
   redis-cli DEL "mangatrack:development:scheduler:lock"
   ```

4. **Verify heartbeat is being sent**:
   ```bash
   redis-cli GET "mangatrack:development:workers:heartbeat"
   ```

5. **Check for environment mismatch**:
   - Ensure `NODE_ENV` is the same for worker and API
   - Ensure `REDIS_URL` points to the same Redis instance

---

## Implementation Tasks

| Task | Priority | Status |
|------|----------|--------|
| Increase heartbeat TTL from 10s to 30s | High | **COMPLETED** |
| Increase check threshold from 15s to 45s | High | **COMPLETED** |
| Add retry logic to `areWorkersOnline()` | Medium | **COMPLETED** |
| Increase heartbeat interval from 10s to 15s | High | **COMPLETED** |
| Add worker status to `/api/health` response | Low | Already implemented |
| Document worker startup in README | Low | Pending |

## Changes Made (Feb 2026)

### `src/lib/redis.ts`
- `setWorkerHeartbeat()`: Increased TTL from 10s to 30s
- `areWorkersOnline()`: 
  - Increased threshold from 15s to 45s
  - Added retry logic with 2 retries and 500ms backoff
  - Added warning log when heartbeat is stale

### `src/workers/index.ts`
- `HEARTBEAT_INTERVAL`: Changed from 10s to 15s

### Timing Summary
| Parameter | Old Value | New Value | Purpose |
|-----------|-----------|-----------|---------|
| Heartbeat interval | 10s | 15s | How often worker sends heartbeat |
| Heartbeat TTL | 10s | 30s | How long key stays in Redis |
| Online threshold | 15s | 45s | How old heartbeat can be |

This provides a 3x buffer (45s / 15s = 3x) which handles:
- GC pauses in worker process
- Redis latency spikes
- Network hiccups
- Clock drift between processes
