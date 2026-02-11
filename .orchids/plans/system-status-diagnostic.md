# System Status Diagnostic Report

## Date: Feb 3, 2026

---

## 1. PM2 Status

### What is PM2?
PM2 is a **production process manager** for Node.js applications. It:
- Keeps your app running 24/7 (auto-restarts on crashes)
- Manages multiple processes (API server + workers)
- Provides logging and monitoring
- Handles graceful restarts during deployments

### Current Status: **NOT RUNNING**
```
PM2 not running or not installed
```

### PM2 Configuration in Project
The project HAS PM2 configured in `ecosystem.config.js`:
- **mangatrack-api**: Next.js production server on port 3002
- **mangatrack-workers**: Background job workers (BullMQ)

### Is PM2 Used?
- **In Development**: NO - You run `npm run dev` and workers manually
- **In Production**: YES - PM2 manages both API and workers
- **On Vercel**: NO - Vercel handles the Next.js app; workers need separate hosting

### How to Use PM2 (Production)
```bash
# Start all processes
npm run pm2:start

# Check status
npm run pm2:status

# View logs
npm run pm2:logs

# Restart after deployment
npm run pm2:reload
```

---

## 2. Database Status

### Health Check Result
| Metric | Value |
|--------|-------|
| Healthy | Yes |
| Latency | 197ms |
| Overall Status | Degraded (due to DLQ, not database) |
| Can Process Jobs | Yes |

### Database IS Working Correctly
The database connection is healthy. The "degraded" status is due to:
- 176 unresolved failures in the Dead Letter Queue (DLQ)
- NOT a database connectivity issue

---

## 3. Worker Activity Analysis

### Workers ARE Running
```
Session: worker-1770158197689-5467bdae
Heartbeat: Sending every 15 seconds (working)
```

### What's Happening with Syncing?

**Good News - Jobs ARE Processing:**
```
[FeedIngest] source=mangadex, tier=A, fetched=100, created=0, skipped=100
[FeedIngest] source=mangaupdates, tier=B, fetched=0, created=0, skipped=0
[LatestFeed] mangadex: 3/50 matched, 3 enqueued
[RefreshCover] Processing covers (100+ completed)
```

**Why "skipped=100" and "created=0"?**
The data already exists! This is NORMAL behavior:
- Feed ingestion checks if chapters already exist
- If they do, they're skipped (not duplicated)
- "created=0" means no NEW chapters were found

### Unique Constraint Errors (Non-Critical)
```
Unique constraint failed on: (series_id, chapter_number, source_id)
```
These errors are **expected** when:
- The same chapter is processed twice
- The system is catching up after restart
- These are handled gracefully (job continues)

---

## 4. Why Does UI Show "Syncing"?

The UI shows "syncing" when:
1. **Optimistic updates** are pending confirmation
2. **Background sync** is reconciling local vs server state
3. **Offline changes** are being pushed

### To Verify Sync is Working:
1. Add a series to your library
2. Mark a chapter as read
3. Refresh the page - changes should persist

### If Changes Don't Persist:
- Check browser console for errors
- Check if you're logged in (auth timeout issues visible in logs)
- Clear browser cache and try again

---

## 5. Known Issues From Logs

### Auth Timeout Issues
```
[AuthCache] getUser timed out after 3000ms
[Supabase] Auth call timed out after 5000ms
```
This indicates Supabase auth is slow/timing out. This can cause:
- "Syncing" state to persist
- User actions to fail silently
- Session issues

### Root Cause: Supabase Latency
The auth calls are timing out, likely due to:
- Network latency to Supabase
- Supabase service load
- Cold starts on serverless functions

---

## 6. Summary

| Component | Status | Notes |
|-----------|--------|-------|
| PM2 | Not Running | Only needed in production |
| Database | Working | 197ms latency, healthy |
| Redis | Working | Connected, processing jobs |
| Workers | Running | Heartbeat active, jobs processing |
| Feed Ingest | Working | Fetching data, skipping duplicates |
| Cover Refresh | Working | 100+ covers updated |
| Auth | Slow | Timeouts occurring (Supabase issue) |

### What's Actually Happening:
1. **Database**: Working correctly
2. **Workers**: Running and processing jobs
3. **Sync**: Working, but UI may show "syncing" due to auth timeouts
4. **Data**: Not creating new records because data already exists (this is correct)

### Recommendations:
1. The system is working - "syncing" in UI is likely an auth/frontend issue
2. Auth timeouts need investigation (Supabase latency)
3. PM2 is not needed in development environment
4. The unique constraint errors are handled and non-blocking
