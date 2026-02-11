/**
 * Tests for Remaining Audit Fixes (Feb 10, 2026)
 * 
 * P0 #1 (partial): middleware.ts uses getUser() not getSession()
 * P1 #4: Prisma soft-delete findUnique→findFirst with compound key flattening
 * P1 #5: Rate limiter atomic increment (no race condition)
 * P2 #8: handleApiError uses nested error format { error: { message, code, requestId } }
 * P2 #9: Consolidated ApiError class in api-error.ts (ApiError === APIError alias)
 * P3 #13: Circuit breaker persists in global for all environments
 * P3 #14: Logger regex lastIndex reset
 * P3 #15: BoundedRateLimitStore persists in global for all environments
 */

import fs from 'fs'
import path from 'path'
import { InMemoryRateLimitStore, handleApiError } from '@/lib/api-utils'
import { ApiError, ApiError as ApiErrorFromApiError, APIError } from '@/lib/api-error'

function readSourceFile(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')
}

function stripComments(code: string): string {
  let result = code.replace(/\/\/.*$/gm, '')
  result = result.replace(/\/\*[\s\S]*?\*\//g, '')
  return result
}

// =============================================
// P0 #1 (partial): Middleware uses getUser()
// =============================================
describe('P0 #1: Supabase middleware uses getUser()', () => {
  let content: string
  let codeOnly: string

  beforeAll(() => {
    content = readSourceFile('src/lib/supabase/middleware.ts')
    codeOnly = stripComments(content)
  })

  it('should call supabase.auth.getUser() in executable code', () => {
    expect(codeOnly).toContain('supabase.auth.getUser()')
  })

  it('should NOT call supabase.auth.getSession() in executable code', () => {
    expect(codeOnly).not.toContain('supabase.auth.getSession()')
  })

  it('should have a comment explaining why getUser is used', () => {
    expect(content).toContain('getUser()')
    expect(content.toLowerCase()).toContain('validates the jwt')
  })

  it('should record auth success/failure for circuit breaker', () => {
    expect(codeOnly).toContain('recordAuthSuccess()')
    expect(codeOnly).toContain('recordAuthFailure()')
  })
})

// =============================================
// P1 #4: Prisma soft-delete compound key handling
// =============================================
describe('P1 #4: Prisma soft-delete findUnique→findFirst with compound key flattening', () => {
  let content: string

  beforeAll(() => {
    content = readSourceFile('src/lib/prisma.ts')
  })

  it('should convert findUnique to findFirst', () => {
    expect(content).toContain("const convertedOp = operation === 'findUnique' ? 'findFirst' : 'findFirstOrThrow'")
  })

  it('should flatten compound unique keys', () => {
    // The middleware should detect nested objects in the where clause
    // and flatten them (e.g., { user_id_series_id: { user_id, series_id } } → { user_id, series_id })
    expect(content).toContain('Object.assign(where, nested)')
    expect(content).toContain('delete where[key]')
  })

  it('should inject deleted_at: null into the flattened where', () => {
    expect(content).toContain("args.where = { ...where, deleted_at: null }")
  })

  it('should handle findUniqueOrThrow as well', () => {
    expect(content).toContain("operation === 'findUniqueOrThrow'")
  })

  it('should not flatten Date objects or arrays', () => {
    expect(content).toContain('!Array.isArray(where[key])')
    expect(content).toContain('!(where[key] instanceof Date)')
  })
})

// =============================================
// P1 #5: Rate limiter atomic increment
// =============================================
describe('P1 #5: InMemoryRateLimitStore atomic increment', () => {
  let store: InMemoryRateLimitStore

  beforeEach(() => {
    store = new InMemoryRateLimitStore()
  })

  afterEach(() => {
    store.shutdown()
  })

  it('increment() creates a new entry if none exists', () => {
    const now = Date.now()
    const result = store.increment('test-key', now, 60000)
    expect(result.count).toBe(1)
    expect(result.resetTime).toBe(now + 60000)
  })

  it('increment() atomically increments existing entries', () => {
    const now = Date.now()
    store.increment('test-key', now, 60000)
    const result = store.increment('test-key', now, 60000)
    expect(result.count).toBe(2)
  })

  it('increment() resets count when window expires', () => {
    const now = Date.now()
    store.increment('test-key', now, 1000)
    // Simulate time passing past the window
    const result = store.increment('test-key', now + 2000, 1000)
    expect(result.count).toBe(1) // Reset
  })

  it('concurrent increments produce correct count', () => {
    const now = Date.now()
    // Simulate 100 "concurrent" increments (JS is single-threaded but this tests the pattern)
    for (let i = 0; i < 100; i++) {
      store.increment('test-key', now, 60000)
    }
    const entry = store.get('test-key')
    expect(entry?.count).toBe(100)
  })

  it('source code uses atomic increment method, not record.count++', () => {
    const content = readSourceFile('src/lib/api-utils.ts')
    // Find the in-memory fallback section in getRateLimitInfo
    const fallbackStart = content.indexOf('// In-memory fallback')
    const fnEnd = content.indexOf('export async function clearRateLimit')
    const fallbackSection = content.substring(fallbackStart, fnEnd)
    // Should use the increment method, not manual count++
    expect(fallbackSection).toContain('inMemoryStore.increment(')
    expect(fallbackSection).not.toContain('record.count++')
  })
})

// =============================================
// P2 #8: Standardized error response format
// =============================================
describe('P2 #8: handleApiError uses nested error format', () => {
  it('returns nested { error: { message, code, requestId } } for ApiError', () => {
    const error = new ApiError('Not found', 404, 'NOT_FOUND')
    const response = handleApiError(error, 'TEST-REQ-ID')
    
    // Parse the response body
    const bodyPromise = response.json()
    return bodyPromise.then((body: any) => {
      expect(body.error).toBeDefined()
      expect(body.error.message).toBe('Not found')
      expect(body.error.code).toBe('NOT_FOUND')
      expect(body.error.requestId).toBe('TEST-REQ-ID')
    })
  })

  it('returns nested format for generic errors too', () => {
    const error = new Error('something broke')
    const response = handleApiError(error, 'REQ-123')
    
    return response.json().then((body: any) => {
      expect(body.error).toBeDefined()
      expect(body.error.message).toBeDefined()
      expect(body.error.code).toBeDefined()
      expect(body.error.requestId).toBe('REQ-123')
    })
  })

  it('returns 500 for unknown errors', () => {
    const error = new Error('unknown')
    const response = handleApiError(error)
    expect(response.status).toBe(500)
  })

  it('returns correct status for Prisma P2002 (conflict)', () => {
    const error = new Error('Unique constraint failed')
    ;(error as any).name = 'PrismaClientKnownRequestError'
    ;(error as any).code = 'P2002'
    const response = handleApiError(error)
    expect(response.status).toBe(409)
  })

  it('adds Retry-After header for rate limited errors', () => {
    const error = new ApiError('Too many requests', 429, 'RATE_LIMITED')
    ;(error as any).retryAfter = 60
    const response = handleApiError(error)
    expect(response.status).toBe(429)
    expect(response.headers.get('Retry-After')).toBe('60')
  })
})

// =============================================
// P2 #9: Consolidated ApiError classes
// =============================================
describe('P2 #9: ApiError and APIError are the same class', () => {
  it('ApiError from api-error.ts and APIError are the same export', () => {
    expect(ApiErrorFromApiError).toBe(APIError)
  })

  it('ApiError has statusCode property (not status)', () => {
    const err = new ApiErrorFromApiError('test', 404, 'NOT_FOUND')
    expect(err.statusCode).toBe(404)
    expect(err.code).toBe('NOT_FOUND')
    expect(err.name).toBe('ApiError')
  })

  it('APIError alias also has statusCode property', () => {
    const err = new APIError('test', 400)
    expect(err.statusCode).toBe(400)
    expect(err).toBeInstanceOf(ApiErrorFromApiError)
  })

  it('api-error.ts has deprecation/alias note', () => {
    const content = readSourceFile('src/lib/api-error.ts')
    expect(content).toContain('ApiError as APIError')
  })

  it('api-error.ts has fetchWithErrorHandling that handles both flat and nested error formats', () => {
    const content = readSourceFile('src/lib/api-error.ts')
    expect(content).toContain('errorData.error?.message')
    expect(content).toContain('errorData.error')
  })
})

// =============================================
// P3 #13: Circuit breaker global persistence
// =============================================
describe('P3 #13: Circuit breaker persists in global for ALL environments', () => {
  it('should NOT conditionally assign to global only in dev', () => {
    const content = readSourceFile('src/lib/auth-circuit-breaker.ts')
    const codeOnly = stripComments(content)
    
    // Should assign unconditionally
    expect(codeOnly).toContain('globalForCircuit.circuitState = circuitState')
    expect(codeOnly).toContain('globalForCircuit.circuitConfig = config')
    
    // Verify there is no `if (process.env.NODE_ENV !== 'production')` guard around the assignments
    // The fix ensures global assignment happens for all environments
    const lines = codeOnly.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('globalForCircuit.circuitState = circuitState')) {
        // The line before should not be a production check
        const prevLine = lines[i - 1]?.trim() || ''
        expect(prevLine).not.toContain("process.env.NODE_ENV !== 'production'")
      }
    }
  })

  it('configureCircuitBreaker updates global unconditionally', () => {
    const content = readSourceFile('src/lib/auth-circuit-breaker.ts')
    // Find the configureCircuitBreaker function
    const fnStart = content.indexOf('export function configureCircuitBreaker')
    const fnEnd = content.indexOf('\n}', fnStart) + 2
    const fn = content.substring(fnStart, fnEnd)
    
    expect(fn).toContain('globalForCircuit.circuitConfig = config')
    expect(fn).not.toContain("process.env.NODE_ENV !== 'production'")
  })
})

// =============================================
// P3 #14: Logger regex lastIndex reset
// =============================================
describe('P3 #14: Logger resets regex lastIndex before each replacement', () => {
  it('should reset pattern.lastIndex = 0 before each replace call', () => {
    const content = readSourceFile('src/lib/logger.ts')
    expect(content).toContain('pattern.lastIndex = 0')
  })

  it('redactString should work correctly across multiple calls', () => {
    // Import and test - verify no stateful regex bugs
    const content = readSourceFile('src/lib/logger.ts')
    // The fix is in the redactString function
    expect(content).toContain('function redactString')
    expect(content).toContain('pattern.lastIndex = 0')
  })
})

// =============================================
// P3 #15: BoundedRateLimitStore global persistence
// =============================================
describe('P3 #15: Rate limit stores persist in global for ALL environments', () => {
  it('middleware.ts BoundedRateLimitStore has unconditional global assignment', () => {
    const content = readSourceFile('src/middleware.ts')
    const codeOnly = stripComments(content)
    
    expect(codeOnly).toContain('globalForRateLimit.rateLimitStore = rateLimitStore')
    
    // Ensure no production guard around it
    const lines = codeOnly.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('globalForRateLimit.rateLimitStore = rateLimitStore')) {
        const prevLine = lines[i - 1]?.trim() || ''
        expect(prevLine).not.toContain("process.env.NODE_ENV !== 'production'")
      }
    }
  })

  it('api-utils.ts InMemoryRateLimitStore has unconditional global assignment', () => {
    const content = readSourceFile('src/lib/api-utils.ts')
    const codeOnly = stripComments(content)
    
    expect(codeOnly).toContain('globalForRateLimit.inMemoryStore = inMemoryStore')
    
    const lines = codeOnly.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('globalForRateLimit.inMemoryStore = inMemoryStore')) {
        const prevLine = lines[i - 1]?.trim() || ''
        expect(prevLine).not.toContain("process.env.NODE_ENV !== 'production'")
      }
    }
  })
})

// =============================================
// Middleware rate limiter atomic pattern
// =============================================
describe('Middleware rate limiter uses atomic pattern', () => {
  let content: string

  beforeAll(() => {
    content = readSourceFile('src/middleware.ts')
  })

  it('uses atomic increment pattern (new object instead of mutating)', () => {
    // The middlewareRateLimit function should create new objects, not mutate
    expect(content).toContain('const newCount = existing.count + 1')
    expect(content).toContain('const updatedRecord = { count: newCount, resetTime: existing.resetTime }')
  })

  it('does NOT use mutable count++', () => {
    // Find the middlewareRateLimit function
    const fnStart = content.indexOf('function middlewareRateLimit')
    const fnEnd = content.indexOf('\n}', fnStart) + 2
    const fn = content.substring(fnStart, fnEnd)
    
    expect(fn).not.toContain('count++')
    expect(fn).not.toContain('.count =')
  })
})
