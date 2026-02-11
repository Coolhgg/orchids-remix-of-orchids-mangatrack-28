/**
 * Integration Tests for /api/auth/login Route
 * Tests rate limiting, lockout, JSON parsing, error sanitization, and happy path
 */

import { checkAuthRateLimit, clearRateLimit, getClientIp, escapeILikePattern } from '@/lib/api-utils'

// Declare mocks with var so they're hoisted above jest.mock factories
var mockSignInWithPassword: jest.Mock
var mockGetAll: jest.Mock
var mockSet: jest.Mock
var mockQueryRaw: jest.Mock
var mockExecuteRaw: jest.Mock
var mockUserUpsert: jest.Mock

jest.mock('@supabase/ssr', () => {
  mockSignInWithPassword = jest.fn()
  return {
    createServerClient: jest.fn(() => ({
      auth: {
        signInWithPassword: mockSignInWithPassword,
      },
    })),
  }
})

jest.mock('next/headers', () => {
  mockGetAll = jest.fn().mockReturnValue([])
  mockSet = jest.fn()
  return {
    cookies: jest.fn(async () => ({
      getAll: mockGetAll,
      set: mockSet,
    })),
  }
})

jest.mock('@/lib/env', () => ({
  getSupabaseUrl: () => 'https://test.supabase.co',
  getSupabaseAnonKey: () => 'test-anon-key',
}))

jest.mock('@/lib/prisma', () => {
  mockQueryRaw = jest.fn()
  mockExecuteRaw = jest.fn()
  mockUserUpsert = jest.fn()
  return {
    prisma: {
      $queryRaw: mockQueryRaw,
      $executeRaw: mockExecuteRaw,
      user: {
        upsert: mockUserUpsert,
      },
    },
    withRetry: jest.fn((fn: () => unknown) => fn()),
  }
})

jest.mock('@/lib/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}))

// Import the route handler after all mocks
import { POST } from '@/app/api/auth/login/route'
import { NextRequest } from 'next/server'

function makeRequest(body: unknown, options?: { invalidJson?: boolean }) {
  const req = new NextRequest('http://localhost:3000/api/auth/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': '127.0.0.1',
    },
    body: options?.invalidJson ? 'not-valid-json{' : JSON.stringify(body),
  })
  return req
}

describe('/api/auth/login', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    clearRateLimit('auth:127.0.0.1')
    // Default: no lockout (0 recent failures)
    mockQueryRaw.mockResolvedValue([{ count: 0 }])
    mockExecuteRaw.mockResolvedValue(1)
    mockUserUpsert.mockResolvedValue({})
  })

  describe('Input Validation', () => {
    it('should return 400 for invalid JSON body', async () => {
      const req = makeRequest(null, { invalidJson: true })
      const res = await POST(req)
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toBe('Invalid request body')
    })

    it('should return 400 when email is missing', async () => {
      const req = makeRequest({ password: 'Test1234' })
      const res = await POST(req)
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toBe('Email and password are required')
    })

    it('should return 400 when password is missing', async () => {
      const req = makeRequest({ email: 'user@test.com' })
      const res = await POST(req)
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toBe('Email and password are required')
    })

    it('should return 400 when both fields are missing', async () => {
      const req = makeRequest({})
      const res = await POST(req)
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toBe('Email and password are required')
    })
  })

  describe('Rate Limiting', () => {
    it('should return 429 after exceeding auth rate limit', async () => {
      // Burn through the rate limit (5 attempts)
      for (let i = 0; i < 5; i++) {
        await checkAuthRateLimit('127.0.0.1')
      }

      const req = makeRequest({ email: 'user@test.com', password: 'Test1234' })
      const res = await POST(req)
      expect(res.status).toBe(429)
      const data = await res.json()
      expect(data.error).toContain('Too many login attempts')
      expect(res.headers.get('Retry-After')).toBe('60')
    })
  })

  describe('Lockout Check', () => {
    it('should return 429 when too many recent failures', async () => {
      // Simulate 5+ recent failures
      mockQueryRaw.mockResolvedValue([{ count: 5 }])

      const req = makeRequest({ email: 'user@test.com', password: 'Test1234' })
      const res = await POST(req)
      expect(res.status).toBe(429)
      const data = await res.json()
      expect(data.error).toContain('Account temporarily locked')
      expect(res.headers.get('Retry-After')).toBe('900')
    })

    it('should proceed if lockout check fails (non-fatal)', async () => {
      mockQueryRaw.mockRejectedValue(new Error('DB connection failed'))
      mockSignInWithPassword.mockResolvedValue({
        data: { user: { id: 'user-1', user_metadata: { username: 'tester' } } },
        error: null,
      })

      const req = makeRequest({ email: 'user@test.com', password: 'Test1234' })
      const res = await POST(req)
      // Should still attempt login since lockout check is non-fatal
      expect(res.status).toBe(200)
    })
  })

  describe('Successful Login', () => {
    it('should return 200 with success:true on valid credentials', async () => {
      mockSignInWithPassword.mockResolvedValue({
        data: { user: { id: 'user-1', user_metadata: { username: 'tester' } } },
        error: null,
      })

      const req = makeRequest({ email: 'user@test.com', password: 'Test1234' })
      const res = await POST(req)
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.success).toBe(true)
    })

    it('should call signInWithPassword with correct credentials', async () => {
      mockSignInWithPassword.mockResolvedValue({
        data: { user: { id: 'user-1', user_metadata: {} } },
        error: null,
      })

      const req = makeRequest({ email: 'user@test.com', password: 'MyPass123' })
      await POST(req)
      expect(mockSignInWithPassword).toHaveBeenCalledWith({
        email: 'user@test.com',
        password: 'MyPass123',
      })
    })
  })

  describe('Error Sanitization', () => {
    it('should return generic message for invalid credentials', async () => {
      mockSignInWithPassword.mockResolvedValue({
        data: { user: null },
        error: { message: 'Invalid login credentials', code: 'invalid_credentials' },
      })

      const req = makeRequest({ email: 'user@test.com', password: 'WrongPass1' })
      const res = await POST(req)
      expect(res.status).toBe(401)
      const data = await res.json()
      expect(data.error).toBe('Invalid email or password')
      // Should NOT leak raw Supabase error
      expect(data.error).not.toContain('Invalid login credentials')
    })

    it('should return email confirmation message', async () => {
      mockSignInWithPassword.mockResolvedValue({
        data: { user: null },
        error: { message: 'Email not confirmed', code: 'email_not_confirmed' },
      })

      const req = makeRequest({ email: 'user@test.com', password: 'Test1234' })
      const res = await POST(req)
      expect(res.status).toBe(401)
      const data = await res.json()
      expect(data.error).toContain('confirm your email')
    })

    it('should return generic error for unknown Supabase errors', async () => {
      mockSignInWithPassword.mockResolvedValue({
        data: { user: null },
        error: { message: 'Internal server error: database connection pool exhausted', code: 'unexpected_failure' },
      })

      const req = makeRequest({ email: 'user@test.com', password: 'Test1234' })
      const res = await POST(req)
      expect(res.status).toBe(401)
      const data = await res.json()
      // Must NOT leak internal error details
      expect(data.error).toBe('Authentication failed. Please try again.')
      expect(data.error).not.toContain('database')
      expect(data.error).not.toContain('pool')
    })

    it('should record failed login attempt on auth failure', async () => {
      mockSignInWithPassword.mockResolvedValue({
        data: { user: null },
        error: { message: 'Invalid login credentials', code: 'invalid_credentials' },
      })
      mockExecuteRaw.mockResolvedValue(1)

      const req = makeRequest({ email: 'user@test.com', password: 'WrongPass1' })
      await POST(req)

      // Should have attempted to record the failure
      expect(mockExecuteRaw).toHaveBeenCalled()
    })
  })

  describe('Edge Cases', () => {
    it('should return 500 when signInData.user is null on success', async () => {
      mockSignInWithPassword.mockResolvedValue({
        data: { user: null },
        error: null,
      })

      const req = makeRequest({ email: 'user@test.com', password: 'Test1234' })
      const res = await POST(req)
      expect(res.status).toBe(500)
      const data = await res.json()
      expect(data.error).toContain('no user returned')
    })
  })
})

describe('Library Search ILIKE Escape', () => {
  it('should escape % wildcard in search queries', () => {
    expect(escapeILikePattern('100%')).toBe('100\\%')
  })

  it('should escape _ wildcard in search queries', () => {
    expect(escapeILikePattern('my_manga')).toBe('my\\_manga')
  })

  it('should escape backslash in search queries', () => {
    expect(escapeILikePattern('test\\value')).toBe('test\\\\value')
  })

  it('should handle clean input unchanged', () => {
    expect(escapeILikePattern('one piece')).toBe('one piece')
  })
})
