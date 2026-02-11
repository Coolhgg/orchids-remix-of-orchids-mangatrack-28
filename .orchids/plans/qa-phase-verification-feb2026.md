# QA Verification Plan - February 2026

## Overview
This plan verifies previous fixes and implements additional enhancements for auth timeout handling, graceful degradation, and TypeScript cleanup.

---

## Phase 1: Verify Previous Fixes

### 1.1 Schema Mismatch Status

**Finding: PARTIALLY RESOLVED - Prisma relation naming issues persist**

The codebase has TypeScript errors related to Prisma schema relations. The AGENTS.md specifies:
- Relations should use singular model name in camelCase (e.g., `user User`)
- Collection relations use plural model name in camelCase (e.g., `activities Activity[]`)

**Current Issues Found (178 errors in main source files):**

| File | Issue | Root Cause |
|------|-------|------------|
| `src/app/api/library/route.ts:150` | `'series' does not exist` | Should use `Series` (PascalCase) |
| `src/app/api/feed/updates/route.ts:132` | `'series' does not exist` | Should use `Series` (PascalCase) |
| `src/app/api/links/[linkId]/route.ts:51` | `'votes' does not exist` | Should use `LinkVote` |
| `src/app/api/admin/db-repair/route.ts:214` | `'sources' does not exist` | Should use `SeriesSource` |
| Multiple files | `'first_detected_at' does not exist` | Column may not exist in Prisma schema |
| Multiple files | `validateContentType` not imported | Missing import statement |

**Verification Steps:**
1. Run `npx prisma generate` to regenerate client
2. Check `prisma/schema.prisma` for relation names
3. Verify relation names match AGENTS.md conventions

**Recommended Fixes:**
```typescript
// WRONG - lowercase relation names
include: { series: true, sources: true }

// CORRECT - PascalCase relation names per Prisma schema
include: { Series: true, SeriesSource: true }
```

---

### 1.2 UUID Validation Status

**Finding: RESOLVED ✅**

The `validateUUID` function is properly implemented and widely used:

**Implementation (`src/lib/api-utils.ts:507-512`):**
```typescript
export function validateUUID(id: string, fieldName = 'id'): void {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!uuidRegex.test(id)) {
    throw new ApiError(`Invalid ${fieldName} format`, 400, 'INVALID_FORMAT')
  }
}
```

**Usage Coverage (verified in 33+ files):**
- `/api/library/[id]/*` - All entry routes ✅
- `/api/notifications/[id]/*` - All notification routes ✅
- `/api/links/[linkId]/*` - All link routes ✅
- `/api/users/me/filters/[id]/*` - All filter routes ✅
- `/api/admin/*` - All admin routes ✅
- `/api/analytics/*` - All analytics routes ✅

**Test Coverage:**
- `src/__tests__/unit/api-utils.test.ts` - Unit tests ✅
- `src/__tests__/api/security.test.ts` - Security tests ✅
- `src/__tests__/integration/api-security.test.ts` - Integration tests ✅

---

## Phase 2: Auth Timeout Handling

### 2.1 Current Implementation

**Middleware Timeout (`src/lib/supabase/middleware.ts`):**
- Timeout: `5000ms` (reduced from 15s) ✅
- Rate-limited logging: `30000ms` interval ✅
- Graceful fallback: Returns 401 with `x-auth-degraded: timeout` header ✅

**Cached User Timeout (`src/lib/supabase/cached-user.ts`):**
- Timeout: `3000ms` ✅
- Retry support: `getUserWithRetry(maxRetries = 2)` with exponential backoff ✅

### 2.2 Recommended Improvements

**Issue 1: No client-side retry on auth timeout**

Currently, when auth times out, the API returns:
```json
{ "error": "unauthorized", "reason": "auth_timeout", "retry": true }
```

But there's no client-side handling for this. 

**Recommendation:** Add frontend retry logic when `x-auth-degraded: timeout` header is present.

**Issue 2: Missing circuit breaker for auth service**

Repeated auth timeouts indicate Supabase is degraded. There's no circuit breaker to prevent cascading failures.

**Recommendation:** Implement circuit breaker pattern:
```typescript
// After 5 consecutive auth timeouts in 30 seconds
// - Open circuit for 60 seconds
// - Allow public access to semi-protected routes
// - Log metric for alerting
```

**Issue 3: No health check for auth service**

**Recommendation:** Add `/api/health/auth` endpoint that:
- Probes Supabase auth with a lightweight call
- Returns degraded status if timeout > 2s
- Can be used by load balancer for routing decisions

---

## Phase 3: Graceful Degradation for Auth Failures

### 3.1 Current Implementation Status

**Implemented:**
- `x-auth-degraded: timeout` header on auth timeout ✅
- `?reason=auth_timeout` query param on login redirect ✅
- `getUserWithRetry()` with exponential backoff ✅
- Public path bypass for known public routes ✅

**Not Implemented:**
- Circuit breaker for auth service ❌
- Cached session fallback ❌
- Guest mode for degraded auth ❌
- Client-side retry handling ❌

### 3.2 Recommended Graceful Degradation Strategy

**Tier 1: Auth Timeout (< 5s)**
- Current behavior: Return 401 with retry hint
- Client retries once after 500ms
- If still fails, show "Authentication service is slow" message

**Tier 2: Auth Degraded (multiple timeouts)**
- Circuit breaker opens after 5 consecutive timeouts
- Public routes continue to work
- Protected routes show "Please try again in a moment" with countdown
- Session cookie is still trusted for 5 minutes if valid

**Tier 3: Auth Down (circuit open)**
- All protected routes return 503 with retry-after header
- Public routes work normally
- Login page shows maintenance message
- Admin dashboard accessible with local fallback auth

### 3.3 Files to Modify

| File | Change |
|------|--------|
| `src/lib/supabase/middleware.ts` | Add circuit breaker state |
| `src/lib/supabase/cached-user.ts` | Add session cache fallback |
| `src/lib/auth-circuit-breaker.ts` | NEW: Circuit breaker implementation |
| `src/app/(auth)/login/page.tsx` | Handle `auth_timeout` query param |
| `src/hooks/useAuth.ts` | Add retry logic for degraded mode |

---

## Phase 4: TypeScript Verification & Cleanup

### 4.1 Error Summary

**Total Errors:** 391
- Main source files (`src/`): 178 errors
- Test files (`__tests__/`): ~150 errors
- Script files (`scripts/`): ~63 errors

### 4.2 Error Categories

**Category 1: Prisma Relation Names (HIGH PRIORITY)**
- ~80 errors
- Cause: Using lowercase relation names instead of PascalCase
- Fix: Update `include` and `select` statements

**Category 2: Missing Imports (MEDIUM PRIORITY)**
- ~15 errors
- Files: `db-repair/route.ts`, `fix-metadata/route.ts`, `lockout/route.ts`
- Fix: Add missing `validateContentType`, `validateJsonSize` imports

**Category 3: Non-existent Properties (MEDIUM PRIORITY)**
- ~40 errors
- Properties: `first_detected_at`, `sources`, `chapter`, `series`
- Cause: Prisma schema may have changed or relations not included

**Category 4: Type Mismatches (LOW PRIORITY)**
- ~20 errors
- Example: `trust_score: boolean | null` vs `trust_score: number`
- Cause: Schema nullability changes

**Category 5: Test File Issues (LOW PRIORITY)**
- ~150 errors in `__tests__/` directory
- Many are mocked function signatures that don't match current implementation
- Lower priority as they don't affect production

### 4.3 Watchdog Status

**Current Health:**
```bash
node scripts/watchdog.js check
# No output = healthy
```

**Watchdog Capabilities:**
- Detects phantom directories (`home/`, `tmp/`, `var/`) ✅
- Removes forbidden dependencies ✅
- Purges bun cache of forbidden packages ✅
- Verifies React version consistency ✅

**Recommended Actions:**
1. Run `node scripts/watchdog.js clean-phantoms`
2. Run `node scripts/watchdog.js ensure`
3. Regenerate Prisma client: `npx prisma generate`

---

## Implementation Priority

### Immediate (Phase 1 Verification)
1. ✅ UUID validation - VERIFIED WORKING
2. ⚠️ Schema mismatches - PRISMA RELATIONS NEED FIXING

### Short-term (Phase 2-3)
3. Add client-side auth retry handling
4. Implement auth circuit breaker
5. Add login page auth_timeout handling

### Medium-term (Phase 4)
6. Fix Prisma relation name mismatches (~80 files)
7. Add missing imports (~5 files)
8. Fix type mismatches (~20 files)
9. Update test mocks (~50+ test files)

---

## Files Requiring Changes

### Critical (Production Impact)

| File | Issue | Fix Required |
|------|-------|--------------|
| `src/app/api/library/route.ts` | `series` relation | Change to `Series` |
| `src/app/api/feed/updates/route.ts` | `series`, `first_detected_at` | Update relations, verify schema |
| `src/app/api/links/[linkId]/route.ts` | Multiple relation errors | Update all relations |
| `src/app/api/admin/db-repair/route.ts` | Missing imports, relations | Add imports, fix relations |
| `src/app/api/auth/lockout/route.ts` | Missing `validateContentType` | Add import |
| `src/lib/cover-resolver.ts` | Promise type mismatch | Fix return types |

### High Priority (Auth Improvements)

| File | Change |
|------|--------|
| `src/lib/supabase/middleware.ts` | Add circuit breaker integration |
| `src/lib/supabase/cached-user.ts` | Add session cache fallback |
| `src/lib/auth-circuit-breaker.ts` | NEW FILE: Circuit breaker |
| `src/app/(auth)/login/page.tsx` | Handle auth_timeout param |

### Medium Priority (Test Fixes)

| Directory | Issue Count | Fix |
|-----------|-------------|-----|
| `src/__tests__/integration/` | ~50 | Update mocks and types |
| `src/__tests__/api/` | ~30 | Update response types |
| `scripts/qa/` | ~40 | Update Prisma queries |

---

## Verification Checklist

### Phase 1: Previous Fixes
- [x] UUID validation function exists and is robust
- [x] UUID validation used in all parameter-accepting routes
- [ ] Prisma schema relations match AGENTS.md conventions
- [ ] `npx prisma generate` produces no errors

### Phase 2: Auth Timeout
- [x] Middleware timeout reduced to 5s
- [x] Rate-limited logging implemented
- [x] Retry function exists (`getUserWithRetry`)
- [ ] Circuit breaker implemented
- [ ] Client-side retry logic added

### Phase 3: Graceful Degradation
- [x] `x-auth-degraded` header implemented
- [x] Login redirect with `?reason=auth_timeout`
- [ ] Login page handles timeout message
- [ ] Session cache fallback implemented
- [ ] Circuit breaker integration complete

### Phase 4: TypeScript
- [ ] Run `node scripts/watchdog.js ensure`
- [ ] Run `npx prisma generate`
- [ ] Fix critical production file errors (6 files)
- [ ] Verify `npx tsc --noEmit` error count reduced
- [ ] All API routes compile without errors

---

## Conclusion

**Phase 1 Status:** UUID validation ✅ COMPLETE, Schema relations ⚠️ NEEDS FIXING
**Phase 2 Status:** Basic timeout handling ✅ COMPLETE, Circuit breaker ❌ NOT IMPLEMENTED
**Phase 3 Status:** Headers/params ✅ COMPLETE, Full graceful degradation ❌ PARTIAL
**Phase 4 Status:** Watchdog healthy ✅, TypeScript errors need resolution ⚠️

**Recommended Next Steps:**
1. Run `npx prisma generate` and verify schema
2. Fix Prisma relation names in API routes (use PascalCase)
3. Add missing imports to flagged files
4. Implement auth circuit breaker for production resilience
5. Add client-side auth retry handling in hooks
