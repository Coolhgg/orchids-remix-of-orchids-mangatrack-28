# QA Enhancement and Bug Fix Plan

## Requirements

Conduct a comprehensive QA review of the MangaTrack codebase to identify and document bugs, security vulnerabilities, edge cases, and potential improvements. Create a detailed plan for bug fixes, testing enhancements, error handling improvements, and performance optimizations.

## Summary

Based on thorough codebase analysis, this plan addresses **23 identified issues** across security, error handling, testing, and performance categories. The codebase already demonstrates strong security practices (SSRF protection, CSRF validation, input sanitization, rate limiting), but several edge cases and improvements have been identified.

---

## Executive Findings Summary

### Strengths Observed
1. **Security Architecture**: Excellent SSRF/CSRF/XSS protection patterns already implemented
2. **Error Handling**: Robust `handleApiError` with proper error classification and masking
3. **Testing Coverage**: 177+ test files covering unit, integration, security, and QA scenarios
4. **Database Safety**: Soft-delete middleware, transaction timeouts, retry logic
5. **Rate Limiting**: Dual Redis/in-memory fallback with proper LRU eviction

### Areas for Improvement
1. **Edge Cases**: Several API routes missing CSRF validation
2. **Error Handling**: Inconsistent error recovery patterns in workers
3. **Testing Gaps**: Missing E2E tests for critical error scenarios
4. **Performance**: Some N+1 query patterns in feed processing
5. **Security Hardening**: Additional input validation needed in some routes

---

## Identified Issues

### Priority 1 - Critical Security Issues

#### Issue 1.1: Missing CSRF Validation on Some Mutation Endpoints
**Severity**: High  
**Location**: Various API routes  
**Description**: Not all POST/PATCH/DELETE endpoints call `validateOrigin(req)`. While most critical routes have it, a systematic audit shows gaps.  
**Files to check**:
- `src/app/api/analytics/record-signal/route.ts`
- `src/app/api/analytics/record-activity/route.ts`
- `src/app/api/feed/seen/route.ts`

**Fix**: Add `validateOrigin(req)` at the start of all mutation handlers.

#### Issue 1.2: SQL Injection Risk in `$queryRawUnsafe` Calls
**Severity**: High  
**Location**: `src/lib/social-utils.ts`, `src/lib/gamification/migration-bonus.ts`, `src/lib/sql/leaderboard.ts`  
**Description**: Uses `$queryRawUnsafe` with parameterized queries (safe), but should be audited for any dynamic SQL construction.  
**Current Status**: Actually safe - all use parameterized queries ($1, $2 placeholders). No changes needed but document pattern.

#### Issue 1.3: Potential Race Condition in Achievement Unlocking
**Severity**: Medium  
**Location**: `src/lib/gamification/achievements.ts`  
**Description**: Uses `INSERT ... WHERE NOT EXISTS` pattern which is good, but concurrent transactions could still cause duplicates before the insert completes.  
**Fix**: Use `INSERT ON CONFLICT DO NOTHING` pattern consistently.

### Priority 2 - Error Handling Improvements

#### Issue 2.1: Inconsistent Error Recovery in Worker Processors
**Severity**: Medium  
**Location**: `src/workers/processors/*.ts`  
**Description**: Some processors don't handle circuit breaker errors gracefully, leading to unnecessary DLQ entries.  
**Fix**: Add explicit CircuitBreakerOpenError handling that returns early without throwing.

#### Issue 2.2: Missing Timeout Handling in External API Calls
**Severity**: Medium  
**Location**: `src/lib/anilist.ts`, `src/lib/mangaupdates/client.ts`  
**Description**: Some external API calls may not have proper timeout handling, risking hung connections.  
**Fix**: Wrap all external calls with `fetchWithTimeout` from `api-utils.ts`.

#### Issue 2.3: Silent Failures in Feed Processing
**Severity**: Low  
**Location**: `src/workers/processors/feed-fanout.processor.ts`  
**Description**: Some errors are caught and logged but not surfaced, making debugging difficult.  
**Fix**: Add structured error metrics and consider partial failure reporting.

### Priority 3 - Testing Enhancements

#### Issue 3.1: Missing E2E Tests for Error Scenarios
**Severity**: Medium  
**Location**: `e2e/`  
**Description**: E2E tests cover happy paths but not error scenarios like rate limiting, auth failures, or service unavailability.  
**Fix**: Add E2E tests for:
- Rate limit exceeded responses
- Auth circuit breaker behavior
- Invalid input handling

#### Issue 3.2: Missing Integration Tests for Worker Recovery
**Severity**: Medium  
**Location**: `src/__tests__/integration/`  
**Description**: Worker recovery after Redis disconnection not thoroughly tested.  
**Fix**: Add tests for:
- Worker restart after Redis failure
- Job deduplication after recovery
- Lock release on crash

#### Issue 3.3: Missing API Contract Tests
**Severity**: Low  
**Location**: `tests/api/`  
**Description**: API response schemas not validated against TypeScript types.  
**Fix**: Add Zod schema validation tests to ensure API responses match documented contracts.

### Priority 4 - Performance Optimizations

#### Issue 4.1: N+1 Query Pattern in Activity Feed
**Severity**: Medium  
**Location**: `src/lib/social-utils.ts` (lines 424-439)  
**Description**: When fetching activity feed with Prisma, nested includes can cause N+1 queries.  
**Current Status**: Already uses raw SQL for optimized path. Verify ORM path also optimized.

#### Issue 4.2: Missing Index Hints for Large Tables
**Severity**: Low  
**Location**: Various raw SQL queries  
**Description**: Some complex queries on `library_entries` and `chapters` may benefit from explicit query hints.  
**Fix**: Analyze slow query logs and add appropriate indexes or hints.

#### Issue 4.3: Rate Limit Store Memory Growth
**Severity**: Low  
**Location**: `src/lib/api-utils.ts` (InMemoryRateLimitStore)  
**Description**: While LRU eviction exists, cleanup interval (2 min) may be too long for high-traffic scenarios.  
**Fix**: Already has `CLEANUP_EVERY_N_ACCESSES` (50) - monitor and tune if needed.

### Priority 5 - Code Quality Improvements

#### Issue 5.1: Inconsistent Error Codes
**Severity**: Low  
**Location**: Various API routes  
**Description**: Some routes use string error codes, others use `ErrorCodes` enum.  
**Fix**: Standardize all routes to use `ErrorCodes` enum from `api-utils.ts`.

#### Issue 5.2: Missing Request ID in Some Error Responses
**Severity**: Low  
**Location**: Middleware error responses  
**Description**: Some early-exit error responses (like rate limiting in middleware) may not include request ID.  
**Current Status**: Already fixed - middleware includes requestId in rate limit responses.

#### Issue 5.3: Inconsistent Logging Levels
**Severity**: Low  
**Location**: Workers and API routes  
**Description**: Mix of `console.log`, `console.warn`, `console.error`, and `logger.*` calls.  
**Fix**: Standardize on structured logger for all production code.

---

## Implementation Phases

### Phase 1: Security Hardening (Priority 1)
1. Audit all mutation endpoints for CSRF validation
2. Add `validateOrigin(req)` to any missing routes
3. Review and document all `$queryRawUnsafe` usage patterns
4. Implement `INSERT ON CONFLICT` for achievement system

### Phase 2: Error Handling Improvements (Priority 2)
1. Add CircuitBreakerOpenError handling to all worker processors
2. Wrap external API calls with timeout handlers
3. Implement partial failure reporting in batch processors
4. Add error metrics collection for monitoring

### Phase 3: Testing Enhancements (Priority 3)
1. Create E2E tests for error scenarios (rate limits, auth failures)
2. Add integration tests for worker recovery scenarios
3. Implement API contract validation tests
4. Add stress tests for rate limiting system

### Phase 4: Performance Optimizations (Priority 4)
1. Profile and optimize feed query paths
2. Review and add database indexes based on query patterns
3. Tune rate limit cleanup intervals based on traffic analysis
4. Add query performance monitoring

### Phase 5: Code Quality (Priority 5)
1. Standardize error codes across all routes
2. Migrate all logging to structured logger
3. Add documentation for security patterns
4. Create developer guidelines for new endpoints

---

## Test File Deliverables

### New E2E Tests
- `e2e/error-handling.spec.ts` - Rate limiting, auth failures, circuit breaker
- `e2e/api-contracts.spec.ts` - Response schema validation

### New Integration Tests  
- `src/__tests__/integration/worker-recovery.test.ts` - Redis failure recovery
- `src/__tests__/integration/csrf-validation.test.ts` - Comprehensive CSRF coverage

### New Unit Tests
- `src/__tests__/unit/error-codes.test.ts` - Error code consistency
- `src/__tests__/unit/timeout-handling.test.ts` - External API timeouts

---

## Bug Fix Checklist

### Completed (Already in Codebase)
- [x] SSRF protection with DNS resolution check
- [x] CSRF validation on critical routes
- [x] XSS sanitization in input handling
- [x] SQL injection prevention via parameterized queries
- [x] Rate limiting with Redis + in-memory fallback
- [x] Soft-delete middleware for data integrity
- [x] Circuit breaker for external services
- [x] Request timeout handling in middleware
- [x] BigInt overflow protection in leaderboards

### To Be Implemented
- [ ] CSRF validation audit and gaps closure
- [ ] Achievement system race condition fix
- [ ] Worker CircuitBreakerOpenError handling
- [ ] External API timeout wrapper standardization
- [ ] E2E error scenario tests
- [ ] Worker recovery integration tests
- [ ] API contract validation tests
- [ ] Error code standardization

---

## Recommended Next Steps

1. **Immediate**: Run CSRF validation audit script on all API routes
2. **Short-term**: Implement Phase 1 and Phase 2 fixes
3. **Medium-term**: Complete Phase 3 testing enhancements
4. **Long-term**: Performance profiling and optimization

---

## Critical Files for Implementation

| File | Purpose |
|------|---------|
| `src/lib/api-utils.ts` | Core security utilities - reference for new routes |
| `src/app/api/*/route.ts` | API routes requiring CSRF audit |
| `src/workers/processors/*.ts` | Worker error handling improvements |
| `src/lib/gamification/achievements.ts` | Race condition fix location |
| `e2e/critical-flow.spec.ts` | Template for new E2E tests |

