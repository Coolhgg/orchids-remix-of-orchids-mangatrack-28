/**
 * Verification Tests for QA Audit Fixes (Feb 10, 2026)
 * 
 * Validates all fixes from the comprehensive QA audit:
 * P0 #1: getUser() security in cached-user.ts (file-level verification)
 * P0 #2: series_completion_xp_granted in bulk endpoint
 * P0 #3: OAuth callback Prisma user upsert
 * P1 #7: Username regex alignment (frontend allows hyphens)
 * P2 #10: validateJsonSize header-only check (no body read)
 * P2 #11: Health endpoint 200 for degraded (not 206)
 * Edge: Soft-delete upsert doesn't clear deleted_at in update clause
 */

import { validateJsonSize, validateUsername, ApiError, USERNAME_REGEX } from '@/lib/api-utils'
import { buildSoftDeleteSafeQuery } from '@/lib/prisma'
import { NextRequest } from 'next/server'
import fs from 'fs'
import path from 'path'

// Helper to read source files for static analysis
function readSourceFile(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')
}

// Helper to strip comments from source code for checking actual code usage
function stripComments(code: string): string {
  // Remove single-line comments
  let result = code.replace(/\/\/.*$/gm, '')
  // Remove multi-line comments
  result = result.replace(/\/\*[\s\S]*?\*\//g, '')
  return result
}

// =============================================
// P0 #1: getSession() replaced with getUser()
// =============================================
describe('P0 #1: cached-user.ts uses getUser() instead of getSession()', () => {
  let content: string
  let codeOnly: string

  beforeAll(() => {
    content = readSourceFile('src/lib/supabase/cached-user.ts')
    codeOnly = stripComments(content)
  })

  it('should use getUser() for server-side JWT validation', () => {
    expect(codeOnly).toContain('supabase.auth.getUser()')
  })

  it('should NOT call getSession() in executable code', () => {
    // getSession() may appear in comments explaining the fix, but NOT in actual code
    expect(codeOnly).not.toContain('supabase.auth.getSession()')
  })

  it('should have security comment explaining the fix', () => {
    expect(content).toContain('SECURITY FIX')
    expect(content).toContain('getUser()')
  })

  it('getCachedUser should still try middleware headers first (fast path)', () => {
    expect(content).toContain('getUserFromMiddlewareHeaders')
    expect(content).toContain('FAST PATH')
  })

  it('getUserWithRetry should also use getUser()', () => {
    // Both getCachedUser and getUserWithRetry should use getUser in code
    const getUserCalls = (codeOnly.match(/supabase\.auth\.getUser\(\)/g) || []).length
    expect(getUserCalls).toBeGreaterThanOrEqual(2)
  })
})

// =============================================
// P0 #2: XP farming prevention in bulk endpoint
// =============================================
describe('P0 #2: Bulk endpoint checks series_completion_xp_granted', () => {
  let content: string

  beforeAll(() => {
    content = readSourceFile('src/app/api/library/bulk/route.ts')
  })

  it('should select series_completion_xp_granted in the findMany', () => {
    expect(content).toContain('series_completion_xp_granted')
  })

  it('should check the flag before awarding completion XP', () => {
    expect(content).toContain('!currentEntry.series_completion_xp_granted')
  })

  it('should set the flag after awarding XP', () => {
    expect(content).toContain('series_completion_xp_granted: true')
  })

  it('should have security comment about XP farming', () => {
    expect(content.toLowerCase()).toContain('xp farm')
  })
})

// =============================================
// P0 #3: OAuth callback creates Prisma user
// =============================================
describe('P0 #3: OAuth callback creates Prisma user record', () => {
  let content: string

  beforeAll(() => {
    content = readSourceFile('src/app/auth/callback/route.ts')
  })

  it('should import prisma', () => {
    expect(content).toContain("import { prisma }")
    expect(content).toContain("from \"@/lib/prisma\"")
  })

  it('should create user record when dbUser.length === 0', () => {
    expect(content).toContain('dbUser.length === 0')
    expect(content).toContain('prisma.user.create')
  })

  it('should handle P2002 unique constraint race condition', () => {
    expect(content).toContain('P2002')
  })

  it('should generate a fallback username from available metadata', () => {
    expect(content).toContain('user_metadata?.username')
    expect(content).toContain("email?.split('@')")
  })

  it('should update email for existing users on OAuth login', () => {
    expect(content).toContain('prisma.user.update')
    expect(content).toContain("data: { email: data.user.email || '' }")
  })
})

// =============================================
// P1 #7: Username regex alignment
// =============================================
describe('P1 #7: Username regex allows hyphens (frontend/backend aligned)', () => {
  it('USERNAME_REGEX allows hyphens', () => {
    expect(validateUsername('my-user')).toBe(true)
    expect(validateUsername('test-user-name')).toBe(true)
  })

  it('USERNAME_REGEX allows underscores', () => {
    expect(validateUsername('my_user')).toBe(true)
    expect(validateUsername('test_user_name')).toBe(true)
  })

  it('USERNAME_REGEX allows mixed hyphens and underscores', () => {
    expect(validateUsername('my-user_name')).toBe(true)
    expect(validateUsername('a_b-c')).toBe(true)
  })

  it('USERNAME_REGEX rejects special characters', () => {
    expect(validateUsername('user@name')).toBe(false)
    expect(validateUsername('user name')).toBe(false)
    expect(validateUsername('user!name')).toBe(false)
    expect(validateUsername('user.name')).toBe(false)
  })

  it('USERNAME_REGEX enforces length bounds (3-30)', () => {
    expect(validateUsername('ab')).toBe(false)
    expect(validateUsername('abc')).toBe(true)
    expect(validateUsername('a'.repeat(30))).toBe(true)
    expect(validateUsername('a'.repeat(31))).toBe(false)
  })

  it('frontend register page allows hyphens in onChange filter', () => {
    const content = readSourceFile('src/app/(auth)/register/page.tsx')
    expect(content).toContain('[^a-z0-9_-]')
  })

  it('frontend register page validation regex matches backend', () => {
    const content = readSourceFile('src/app/(auth)/register/page.tsx')
    expect(content).toContain('[a-zA-Z0-9_-]')
  })

  it('frontend helper text mentions hyphens', () => {
    const content = readSourceFile('src/app/(auth)/register/page.tsx')
    expect(content.toLowerCase()).toContain('hyphen')
  })
})

// =============================================
// P2 #10: validateJsonSize header-only (no body read)
// =============================================
describe('P2 #10: validateJsonSize uses Content-Length only', () => {
  it('rejects when Content-Length exceeds limit', async () => {
    const req = new NextRequest('http://localhost/api/test', {
      method: 'POST',
      headers: { 'content-length': '2000000' },
      body: 'x',
    })
    await expect(validateJsonSize(req as any)).rejects.toThrow('Payload too large')
  })

  it('rejects with custom max bytes', async () => {
    const req = new NextRequest('http://localhost/api/test', {
      method: 'POST',
      headers: { 'content-length': '500' },
      body: 'x',
    })
    await expect(validateJsonSize(req as any, 100)).rejects.toThrow('Payload too large')
  })

  it('allows when Content-Length is within limit', async () => {
    const req = new NextRequest('http://localhost/api/test', {
      method: 'POST',
      headers: { 'content-length': '500' },
      body: JSON.stringify({ data: 'small' }),
    })
    await expect(validateJsonSize(req as any)).resolves.toBeUndefined()
  })

  it('allows when no Content-Length header present', async () => {
    const req = new NextRequest('http://localhost/api/test', {
      method: 'POST',
    })
    await expect(validateJsonSize(req as any)).resolves.toBeUndefined()
  })

  it('does NOT consume the request body stream', async () => {
    const body = JSON.stringify({ key: 'value' })
    const req = new NextRequest('http://localhost/api/test', {
      method: 'POST',
      headers: { 'content-length': String(body.length) },
      body,
    })
    
    await validateJsonSize(req as any)
    
    const parsed = await req.json()
    expect(parsed).toEqual({ key: 'value' })
  })

  it('source code does NOT clone or read body stream', () => {
    const content = readSourceFile('src/lib/api-utils.ts')
    const fnStart = content.indexOf('export async function validateJsonSize')
    const fnEnd = content.indexOf('\n}', fnStart)
    const fnBody = content.substring(fnStart, fnEnd)
    
    expect(fnBody).not.toContain('.clone()')
    expect(fnBody).not.toContain('.text()')
    expect(fnBody).not.toContain('.arrayBuffer()')
  })
})

// =============================================
// P2 #11: Health endpoint 200 for degraded
// =============================================
describe('P2 #11: Health endpoint returns 200 for degraded', () => {
  let content: string
  let codeOnly: string

  beforeAll(() => {
    content = readSourceFile('src/app/api/health/route.ts')
    codeOnly = stripComments(content)
  })

  it('should NOT use 206 status code in executable code', () => {
    // 206 may appear in comments explaining the fix but not in actual code
    expect(codeOnly).not.toContain('206')
  })

  it('should use 200 for both healthy and degraded', () => {
    expect(content).toContain("case 'healthy':")
    expect(content).toContain("case 'degraded':")
    expect(content).toContain('httpStatus = 200')
  })

  it('should use 503 for unhealthy', () => {
    expect(content).toContain("case 'unhealthy':")
    expect(content).toContain('httpStatus = 503')
  })

  it('should include X-Health-Status header to distinguish states', () => {
    expect(content).toContain("'X-Health-Status': overallStatus")
  })

  it('should have a fix comment about degraded status', () => {
    expect(content).toContain('FIX')
    expect(content.toLowerCase()).toContain('degraded')
  })
})

// =============================================
// Edge case: Soft-delete upsert behavior
// =============================================
describe('Edge case: Soft-delete upsert in prisma.ts', () => {
  let content: string

  beforeAll(() => {
    content = readSourceFile('src/lib/prisma.ts')
  })

  it('should set deleted_at: null in create clause of upsert', () => {
    expect(content).toContain('args.create = { ...args.create, deleted_at: null }')
  })

  it('should NOT set deleted_at: null in update clause of upsert', () => {
    const upsertStart = content.indexOf("if (operation === 'upsert')")
    const upsertEnd = content.indexOf('}', content.indexOf('}', content.indexOf('}', upsertStart) + 1) + 1)
    const upsertBlock = content.substring(upsertStart, upsertEnd)
    
    expect(upsertBlock).not.toContain('args.update = { ...args.update, deleted_at: null }')
  })

    it('should have comment explaining the fix', () => {
      expect(content).toContain('Soft-delete-safe upsert')
    })
})

// =============================================
// buildSoftDeleteSafeQuery behavior
// =============================================
describe('buildSoftDeleteSafeQuery', () => {
  it('adds WHERE clause for soft-delete tables', () => {
    const result = buildSoftDeleteSafeQuery('SELECT * FROM users', 'users')
    expect(result).toContain('deleted_at IS NULL')
  })

  it('appends to existing WHERE clause', () => {
    const result = buildSoftDeleteSafeQuery('SELECT * FROM users WHERE id = 1', 'users')
    expect(result).toContain('deleted_at IS NULL AND')
    expect(result).toContain('id = 1')
  })

  it('skips if deleted_at already present', () => {
    const query = 'SELECT * FROM users WHERE deleted_at IS NULL AND id = 1'
    expect(buildSoftDeleteSafeQuery(query, 'users')).toBe(query)
  })

  it('skips non-soft-delete tables', () => {
    const query = 'SELECT * FROM audit_logs'
    expect(buildSoftDeleteSafeQuery(query, 'audit_logs')).toBe(query)
  })

  it('inserts before ORDER BY', () => {
    const result = buildSoftDeleteSafeQuery('SELECT * FROM users ORDER BY created_at', 'users')
    expect(result.indexOf('deleted_at')).toBeLessThan(result.indexOf('ORDER BY'))
  })

  it('inserts before LIMIT', () => {
    const result = buildSoftDeleteSafeQuery('SELECT * FROM series LIMIT 10', 'series')
    expect(result.indexOf('deleted_at')).toBeLessThan(result.indexOf('LIMIT'))
  })

  it('inserts before GROUP BY', () => {
    const result = buildSoftDeleteSafeQuery('SELECT status, count(*) FROM LibraryEntry GROUP BY status', 'LibraryEntry')
    expect(result.indexOf('deleted_at')).toBeLessThan(result.indexOf('GROUP BY'))
  })

  it('handles Chapter model (soft-delete)', () => {
    const result = buildSoftDeleteSafeQuery('SELECT * FROM chapters', 'chapters')
    expect(result).toContain('deleted_at IS NULL')
  })
})

// =============================================
// ApiError class validation
// =============================================
describe('ApiError class', () => {
  it('has correct name for instanceof checks', () => {
    const err = new ApiError('test', 400, 'BAD_REQUEST')
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('ApiError')
  })

  it('carries statusCode and code', () => {
    const err = new ApiError('Payload too large', 413, 'PAYLOAD_TOO_LARGE')
    expect(err.statusCode).toBe(413)
    expect(err.code).toBe('PAYLOAD_TOO_LARGE')
    expect(err.message).toBe('Payload too large')
  })

  it('defaults statusCode to 500', () => {
    const err = new ApiError('oops')
    expect(err.statusCode).toBe(500)
  })
})
