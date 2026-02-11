# Bug Fix & Cleanup Sprint

## Requirements

Address the following prioritized fixes:
- **BUG-B**: Fix SQL injection in `bug-fixes/metadata-resolution.ts` and `database-prisma.ts`
- **BUG-A**: Replace local UUID_REGEX copies with shared `validateUUID` import (8 files)
- **PERF-A**: Migrate API routes from `createClient+getUser` to `getMiddlewareUser`
- **SEC-B**: Fix `validateJsonSize` to check actual body size, not just Content-Length header
- **BUG-C**: Replace `console.*` with `logger.*` in highest-impact lib/ files
- **CLEANUP**: Consolidate duplicate UUID_REGEX definitions into shared export
- Verify fixes compile and test critical paths

## Analysis Summary

### Already Fixed (No Action Required)

1. **BUG-B (SQL Injection)**: ALREADY FIXED
   - `metadata-resolution.ts:65-81` has whitelist validation (`ALLOWED_TABLES`, `ALLOWED_COLUMNS`) and `UUID_REGEX.test(id)` check before SQL execution
   - `database-prisma.ts:248-267` has identical whitelist validation (`SOFT_DELETE_ALLOWED_TABLES`, `SOFT_DELETE_ALLOWED_COLUMNS`) and `UUID_REGEX.test(id)` check

2. **SEC-B (validateJsonSize)**: ALREADY FIXED
   - `api-utils.ts:144-163` correctly clones the request body and streams it to verify actual byte size, not just Content-Length header

3. **CLEANUP (UUID_REGEX consolidation)**: ALREADY CONSOLIDATED
   - Canonical export at `api-utils.ts:572` (`UUID_REGEX`)
   - All runtime files (`metadata-resolution.ts`, `database-prisma.ts`, `scrapers/index.ts`, `EnhancedChapterList.tsx`, analytics routes) already import from `@/lib/api-utils`
   - `MANGADEX_UUID_REGEX` in `mangadex-utils.ts` is domain-specific alias (same pattern, different semantic purpose) - acceptable

### Remaining Work

#### BUG-A: Test files with local UUID_REGEX copies (LOW PRIORITY)
- `src/__tests__/integration/security.test.ts` - 4 local definitions
- `src/__tests__/integration/qa-critical-paths-jan2026.test.ts` - 1 local definition
- `src/__tests__/integration/critical-flows.test.ts` - 1 local definition
- `src/__tests__/api/qa-routes-validation.test.ts` - 1 local definition

**Decision**: These test files intentionally define local regex for self-contained unit tests. This is acceptable test isolation practice. No changes needed.

#### PERF-A: Migrate API routes from createClient+getUser to getMiddlewareUser

28 routes still use `createClient` from `@/lib/supabase/server`:

**High-impact routes to migrate (auth-only, no DB queries via supabase):**
1. `src/app/api/users/me/route.ts` - GET/PATCH/DELETE
2. `src/app/api/users/me/xp-progress/route.ts`
3. `src/app/api/users/me/achievements/route.ts`
4. `src/app/api/users/me/achievements/seasonal/route.ts`
5. `src/app/api/series/[id]/metadata/route.ts`
6. `src/app/api/library/import/route.ts`
7. `src/app/api/library/import/results/route.ts`
8. `src/app/api/library/retry-all-metadata/route.ts`
9. `src/app/api/library/[id]/retry-metadata/route.ts`
10. `src/app/api/library/[id]/fix-metadata/route.ts`

**Routes that CANNOT be migrated (use supabase client for DB queries):**
- `src/app/api/users/me/filters/route.ts` - queries `saved_filters` table via supabase
- `src/app/api/users/me/filters/[id]/route.ts` - queries `saved_filters` table
- `src/app/api/users/[username]/*` routes - public profile routes, may need unauthenticated access
- `src/app/api/links/*` routes - complex supabase queries
- `src/app/api/admin/*` routes - require supabase admin client

#### BUG-C: Replace console.* with logger.* in lib/ files

154 console.* calls across 42 lib files. Priority files (server-side, high-traffic):

**Must Fix (server-side, frequently called):**
1. `src/lib/sync/reconciler.ts` - 11 calls (client-side, SKIP)
2. `src/lib/supabase/middleware.ts` - 3 calls
3. `src/lib/supabase/cached-user.ts` - 4 calls
4. `src/lib/supabase/admin.ts` - 2 calls
5. `src/lib/feed-cache.ts` - 3 calls
6. `src/lib/rate-limiter.ts` - 2 calls
7. `src/lib/queues.ts` - 4 calls
8. `src/lib/gamification/read-telemetry.ts` - 5 calls
9. `src/lib/gamification/achievement-progress.ts` - 2 calls

**Skip (intentional or client-side):**
- `src/lib/logger.ts` - logger implementation, uses console internally (correct)
- `src/lib/monitoring.ts` - error monitoring framework, intentional console usage
- `src/lib/sync/reconciler.ts` - client-side sync, uses `navigator.onLine`
- `src/lib/hooks/use-current-user.ts` - client-side hook
- `src/lib/mangadex/*.ts`, `src/lib/mangaupdates/*.ts` - mostly JSDoc examples

## Implementation Phases

### Phase 1: PERF-A - Migrate High-Impact Routes to getMiddlewareUser
- Migrate `users/me/route.ts` GET/PATCH/DELETE handlers
- Migrate `users/me/xp-progress/route.ts`
- Migrate `users/me/achievements/route.ts` and `achievements/seasonal/route.ts`
- Migrate `library/import/route.ts` and `library/import/results/route.ts`
- Migrate `library/[id]/retry-metadata/route.ts` and `library/[id]/fix-metadata/route.ts`
- Migrate `series/[id]/metadata/route.ts`
- Pattern: Replace `const supabase = await createClient(); const { data: { user } } = await supabase.auth.getUser()` with `const user = await getMiddlewareUser()`

### Phase 2: BUG-C - Replace console.* with logger.* in Server-Side Lib Files
- Add `import { logger } from '@/lib/logger'` to files without it
- Replace `console.error('msg', err)` with `logger.error('msg', { error: err instanceof Error ? err.message : String(err) })`
- Replace `console.warn('msg')` with `logger.warn('msg')`
- Replace `console.log('msg')` with `logger.info('msg')` or `logger.debug('msg')`
- Files: `supabase/middleware.ts`, `supabase/cached-user.ts`, `supabase/admin.ts`, `feed-cache.ts`, `rate-limiter.ts`, `queues.ts`, `gamification/read-telemetry.ts`, `gamification/achievement-progress.ts`

### Phase 3: Verification
- Run `npx tsc --noEmit` to verify no compilation errors
- Test critical API routes with curl commands
- Verify middleware user injection works correctly

## Files to Modify

### PERF-A Route Migrations (10 files)
| File | Change |
|------|--------|
| `src/app/api/users/me/route.ts` | Replace createClient+getUser with getMiddlewareUser |
| `src/app/api/users/me/xp-progress/route.ts` | Replace createClient+getUser with getMiddlewareUser |
| `src/app/api/users/me/achievements/route.ts` | Replace createClient+getUser with getMiddlewareUser |
| `src/app/api/users/me/achievements/seasonal/route.ts` | Replace createClient+getUser with getMiddlewareUser |
| `src/app/api/series/[id]/metadata/route.ts` | Replace createClient+getUser with getMiddlewareUser |
| `src/app/api/library/import/route.ts` | Replace createClient+getUser with getMiddlewareUser |
| `src/app/api/library/import/results/route.ts` | Replace createClient+getUser with getMiddlewareUser |
| `src/app/api/library/retry-all-metadata/route.ts` | Replace createClient+getUser with getMiddlewareUser |
| `src/app/api/library/[id]/retry-metadata/route.ts` | Replace createClient+getUser with getMiddlewareUser |
| `src/app/api/library/[id]/fix-metadata/route.ts` | Replace createClient+getUser with getMiddlewareUser |

### BUG-C Logger Migrations (8 files)
| File | console.* count | Change |
|------|-----------------|--------|
| `src/lib/supabase/middleware.ts` | 3 | Replace with logger.warn/error |
| `src/lib/supabase/cached-user.ts` | 4 | Replace with logger.warn/error |
| `src/lib/supabase/admin.ts` | 2 | Replace with logger.error |
| `src/lib/feed-cache.ts` | 3 | Replace with logger.warn |
| `src/lib/rate-limiter.ts` | 2 | Replace with logger.warn |
| `src/lib/queues.ts` | 4 | Replace with logger.info/error |
| `src/lib/gamification/read-telemetry.ts` | 5 | Replace with logger.error/info |
| `src/lib/gamification/achievement-progress.ts` | 2 | Replace with logger.error |

## Risks & Mitigations

1. **getMiddlewareUser returns null for unauthenticated requests**
   - Mitigation: Each route already checks for null user and throws 401 - pattern unchanged

2. **Logger context format differs from console arguments**
   - Mitigation: Use `{ error: err instanceof Error ? err.message : String(err) }` pattern consistently

3. **Some routes may need supabase client for other operations**
   - Mitigation: Only migrate routes that use supabase SOLELY for auth; keep client for DB operations

## Success Criteria

- [ ] Zero TypeScript compilation errors
- [ ] All migrated routes return correct 401 for unauthenticated requests
- [ ] All migrated routes return correct 200/201 for authenticated requests
- [ ] No console.* calls in target lib files (except logger.ts, monitoring.ts, client-side files)
