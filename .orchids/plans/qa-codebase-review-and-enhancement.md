# QA Codebase Review and Enhancement Plan

## Overview
Comprehensive quality assurance review and enhancement of the MangaTrack manga tracking platform. This plan covers bug identification, security vulnerabilities, integration testing, error handling improvements, and performance optimizations.

## Requirements
Perform a thorough QA review of the MangaTrack codebase including:
1. Identify and fix bugs, security vulnerabilities, and edge cases
2. Develop integration tests for critical functionalities
3. Improve error handling and performance
4. Deliver bug fix report and checklist

## Tech Stack
- **Frontend**: Next.js 15 (App Router), React 19, Tailwind CSS
- **Backend**: Next.js API Routes, Prisma ORM
- **Database**: Supabase (PostgreSQL)
- **Cache/Queue**: Redis, BullMQ
- **Package Manager**: Bun 1.2.0

---

## Bug Audit Summary

### Critical Severity Bugs (P0)

#### BUG-001: Race Condition in Progress Update XP Grant
**Location**: `src/app/api/library/[id]/progress/route.ts`
**Issue**: Despite using `SELECT FOR UPDATE`, there's a potential race condition window between checking `alreadyReadTarget` and the actual XP grant if two concurrent requests target the same chapter.
**Fix**: The raw SQL lock with `FOR UPDATE` is correctly implemented, but the `alreadyReadTarget` check queries `userChapterReadV2` without holding a lock on that row. Add `FOR UPDATE` to the `findUnique` check or use an atomic upsert pattern.
**Impact**: Double XP grant in rare concurrent update scenarios.

#### BUG-002: Missing CSRF Validation on GET Routes with Side Effects
**Location**: Multiple routes performing analytics/tier promotion on GET
**Issue**: `src/app/api/series/search/route.ts` calls `promoteSeriesTier()` on GET requests without CSRF protection.
**Fix**: Side effects from GET requests should be idempotent and not require CSRF, but consider moving tier promotion to a background job or ensuring it's truly idempotent.
**Impact**: Low - tier promotion is idempotent but could be triggered by CSRF.

#### BUG-003: Soft Delete Filter Missing in Raw SQL Joins
**Location**: `src/lib/sql/browse-query-builder.ts`
**Issue**: When joining `series_sources` table, the query only filters `s.deleted_at IS NULL` for series but doesn't verify `series_sources` soft delete status.
**Fix**: Add `ss.deleted_at IS NULL` condition to all joins involving soft-delete enabled tables.
**Impact**: Potentially returning data linked to soft-deleted records.

### High Severity Bugs (P1)

#### BUG-004: Integer Overflow in Leaderboard BigInt Conversion
**Location**: `src/lib/sql/leaderboard.ts`
**Issue**: ROW_NUMBER() returns BigInt in PostgreSQL, conversion to Number may overflow for very large datasets.
**Fix**: Use `BigInt(r.rank).toString()` or ensure rank is always within Number.MAX_SAFE_INTEGER bounds.
**Impact**: Incorrect rank display for large leaderboards.

#### BUG-005: Missing Rate Limit on Feed Realtime Endpoint
**Location**: `src/app/api/feed/realtime/route.ts`
**Issue**: Need to verify rate limiting is applied to the realtime feed endpoint.
**Fix**: Add explicit rate limit check at the start of the handler.
**Impact**: Potential DoS vector.

#### BUG-006: Uncapped Pagination Offset in Multiple Routes
**Location**: Various API routes
**Issue**: While `parsePaginationParams` caps offset at 1,000,000, some routes may bypass this using custom parsing.
**Fix**: Audit all pagination implementations to use centralized `parsePaginationParams()`.
**Impact**: Database performance degradation from large offsets.

#### BUG-007: Memory Leak in In-Memory Rate Limit Store
**Location**: `src/lib/api-utils.ts` - `InMemoryRateLimitStore`
**Issue**: Cleanup interval may not fire in serverless environments. The `maybeCleanup` heuristic helps but needs testing.
**Fix**: Ensure cleanup runs on every N-th access regardless of time, which is partially implemented but could be more aggressive.
**Impact**: Memory growth in long-running processes.

### Medium Severity Bugs (P2)

#### BUG-008: Missing Input Sanitization for Alternative Titles
**Location**: Search and browse queries
**Issue**: Alternative titles from MangaDex API may contain special characters that aren't sanitized before database insertion.
**Fix**: Apply `sanitizeInput()` to all user-facing string fields during import/sync.
**Impact**: Potential XSS if titles contain HTML.

#### BUG-009: Inconsistent Error Response Format
**Location**: Various API routes
**Issue**: Some routes return `{ error: string }` while others return `{ error: string, code: string }`. The `handleApiError` function standardizes this but some direct returns bypass it.
**Fix**: Ensure all error responses go through `handleApiError()` or `withErrorHandling()`.
**Impact**: Inconsistent client-side error handling.

#### BUG-010: Missing Timezone Handling in Streak Calculation
**Location**: `src/lib/gamification/streaks.ts`
**Issue**: Streak calculations may not account for user timezone, potentially breaking/maintaining streaks incorrectly at day boundaries.
**Fix**: Store user timezone preference and calculate day boundaries accordingly.
**Impact**: Incorrect streak counts for users in different timezones.

### Low Severity Bugs (P3)

#### BUG-011: Unused Feature Flag Checks
**Location**: `src/lib/api-utils.ts`
**Issue**: `checkMemoryGuard()` is called but `isFeatureEnabled('memory_guards')` may not be defined in all environments.
**Fix**: Ensure feature flag defaults are properly set.
**Impact**: Feature may be silently disabled.

#### BUG-012: Console Warnings in Production
**Location**: Various files using `console.warn`
**Issue**: Deprecation and fallback warnings appear in production logs.
**Fix**: Gate warnings behind `NODE_ENV !== 'production'` or use proper logger levels.
**Impact**: Log noise.

---

## Security Vulnerabilities

### SEC-001: DNS Rebinding Window (Medium)
**Location**: `src/app/api/proxy/image/route.ts`
**Status**: MITIGATED - DNS resolution check is performed, but there's a theoretical window between DNS check and fetch.
**Recommendation**: Consider using IP-based fetch or DNS pinning.

### SEC-002: Source ID Regex May Allow Injection (Low)
**Location**: `src/lib/scrapers/index.ts`
**Status**: PARTIALLY MITIGATED - `SOURCE_ID_REGEX = /^[a-zA-Z0-9._-]{1,500}$/` is good but 500 chars is generous.
**Recommendation**: Reduce to 200 chars max.

### SEC-003: Missing Origin Validation on Some Mutation Endpoints (Medium)
**Location**: Various POST/PATCH endpoints
**Status**: CHECK NEEDED - Verify all mutation endpoints call `validateOrigin(req)`.
**Recommendation**: Add lint rule or test to ensure all POST/PATCH/DELETE routes include CSRF protection.

### SEC-004: Information Disclosure in Error Messages (Low)
**Location**: `src/lib/api-utils.ts`
**Status**: MOSTLY MITIGATED - Generic messages are used but some Prisma errors may leak schema info.
**Recommendation**: Ensure all Prisma error messages are sanitized.

---

## Integration Testing Plan

### Phase 1: Critical User Flows (Priority)

#### Test Suite: Authentication Flow
```
e2e/auth-flow.spec.ts
- Landing page accessible
- Register with valid credentials
- Email confirmation flow (mock)
- Login with credentials
- Session persistence
- Logout and session cleanup
- OAuth flows (Google, Discord)
```

#### Test Suite: Library Management
```
e2e/library-flow.spec.ts
- Add series to library
- Update reading progress
- XP grant verification (single grant per progress)
- Status change (reading -> completed)
- Remove series from library
- Bulk operations
- Re-add previously removed series
```

#### Test Suite: Search and Discovery
```
e2e/search-flow.spec.ts
- Basic text search
- Filter by genre/type/status
- Cursor-based pagination
- External source discovery (mock MangaDex)
- Search rate limiting
```

### Phase 2: API Contract Tests

#### Test Suite: API Response Validation
```
tests/api/response-contracts.test.ts
- All endpoints return consistent error format
- Rate limit headers are included
- CORS headers are correct
- Content-Type is always application/json
```

#### Test Suite: Security Tests
```
tests/api/security.test.ts
- CSRF protection on all mutations
- Rate limiting works correctly
- Auth required on protected endpoints
- Soft delete filtering works
```

### Phase 3: Integration Tests

#### Test Suite: Worker Integration
```
tests/workers/integration.test.ts
- Chapter ingestion pipeline
- Notification delivery
- Feed fanout
- Import processing
```

---

## Error Handling Improvements

### EH-001: Add Global Error Boundary for Workers
**Location**: `src/workers/index.ts`
**Change**: Add try-catch around all processor invocations with structured logging.

### EH-002: Implement Retry with Circuit Breaker Pattern
**Location**: `src/lib/prisma.ts`
**Change**: The `withRetry` function exists but circuit breaker should be added for external API calls.

### EH-003: Improve Transaction Timeout Handling
**Location**: `src/lib/prisma.ts`
**Change**: Add specific error type for transaction timeouts to distinguish from other failures.

### EH-004: Add Request Context to All Error Logs
**Location**: `src/lib/api-utils.ts`
**Change**: Include request path, method, and user ID in all error logs.

---

## Performance Optimizations

### PERF-001: N+1 Query in Library GET
**Location**: `src/app/api/library/route.ts`
**Issue**: Series data is eagerly loaded which is good, but cover resolution may trigger additional queries.
**Fix**: Batch cover URL validation.

### PERF-002: Redundant Cache Checks in Search
**Location**: `src/app/api/series/search/route.ts`
**Issue**: Multiple cache operations could be batched.
**Fix**: Use Redis pipeline for cache operations.

### PERF-003: Worker Concurrency Tuning
**Location**: `src/lib/audit-pass3-fixes.ts`
**Issue**: Default concurrency settings may not be optimal.
**Fix**: Environment-based tuning is implemented but needs monitoring.

### PERF-004: Index Optimization for Browse Queries
**Location**: Database schema
**Issue**: Complex browse queries may benefit from additional indexes.
**Fix**: Add composite indexes for common filter combinations.

---

## Implementation Phases

### Phase 1: Critical Bug Fixes (Days 1-2)
1. [ ] Fix BUG-001: Race condition in progress XP grant
2. [ ] Fix BUG-003: Soft delete filter in raw SQL joins
3. [ ] Fix BUG-004: BigInt overflow in leaderboard
4. [ ] Audit SEC-003: CSRF validation completeness

### Phase 2: Integration Tests (Days 3-5)
5. [ ] Create `e2e/library-flow.spec.ts` for library management tests
6. [ ] Create `e2e/search-flow.spec.ts` for search functionality tests
7. [ ] Create `tests/api/response-contracts.test.ts` for API validation
8. [ ] Create `tests/api/security.test.ts` for security tests

### Phase 3: Error Handling (Days 6-7)
9. [ ] Implement EH-001: Global error boundary for workers
10. [ ] Implement EH-003: Transaction timeout handling
11. [ ] Implement EH-004: Request context in error logs

### Phase 4: Performance (Days 8-9)
12. [ ] Implement PERF-002: Redis pipeline for search cache
13. [ ] Review and optimize PERF-001: Library query batching
14. [ ] Add monitoring for PERF-003: Worker concurrency

### Phase 5: Documentation & Cleanup (Day 10)
15. [ ] Generate bug fix report
16. [ ] Update AGENTS.md with new patterns
17. [ ] Final checklist and handoff

---

## Test File Structure

```
tests/
├── api/
│   ├── response-contracts.test.ts
│   ├── security.test.ts
│   └── rate-limiting.test.ts
├── lib/
│   ├── gamification/
│   │   ├── xp.test.ts
│   │   ├── achievements.test.ts
│   │   └── streaks.test.ts
│   ├── api-utils.test.ts
│   └── prisma.test.ts
└── workers/
    └── integration.test.ts

e2e/
├── auth-flow.spec.ts (exists: landing-and-auth.spec.ts)
├── library-flow.spec.ts (new)
├── search-flow.spec.ts (new)
├── critical-flow.spec.ts (exists)
└── api-schema.spec.ts (exists)
```

---

## Deliverables Checklist

### Bug Fixes
- [ ] BUG-001 through BUG-012 reviewed and fixed where applicable
- [ ] SEC-001 through SEC-004 reviewed and mitigated

### Test Files
- [ ] `e2e/library-flow.spec.ts` - Library management E2E tests
- [ ] `e2e/search-flow.spec.ts` - Search functionality E2E tests
- [ ] `tests/api/response-contracts.test.ts` - API contract tests
- [ ] `tests/api/security.test.ts` - Security tests

### Documentation
- [ ] Bug fix report summarizing all changes
- [ ] Updated AGENTS.md with QA guidelines
- [ ] Final checklist with remaining issues and recommendations

---

## Remaining Issues (Post-Implementation)

### Known Limitations
1. MangaDex rate limiting is respected but may need adjustment based on production traffic
2. Worker scaling requires manual tuning per environment
3. Timezone handling for streaks needs user timezone storage

### Recommended Next Steps
1. Implement user timezone preference
2. Add APM/observability tooling
3. Create load testing suite
4. Implement canary deployment strategy
5. Add database query performance monitoring

---

## Critical Files for Implementation

### Primary Files to Modify
- `src/app/api/library/[id]/progress/route.ts` - XP race condition fix
- `src/lib/sql/browse-query-builder.ts` - Soft delete filter fix
- `src/lib/sql/leaderboard.ts` - BigInt conversion fix

### Test Files to Create
- `e2e/library-flow.spec.ts`
- `e2e/search-flow.spec.ts`
- `tests/api/response-contracts.test.ts`
- `tests/api/security.test.ts`

### Files to Review
- All files in `src/app/api/` for CSRF validation
- All files using raw SQL for soft delete compliance
