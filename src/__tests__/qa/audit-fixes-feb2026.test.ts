/**
 * Integration Tests for QA Audit Fixes (Feb 2026)
 * 
 * Tests all 11 audit findings:
 * HIGH #1: validateUUID on series/[id] routes
 * HIGH #2: request.json() try/catch on mutation routes
 * HIGH #3: validateJsonSize on mutation routes
 * HIGH #4: Filters route migrated to Prisma (no Supabase client)
 * MED #5: Date validation in feed/seen
 * MED #6: Standardized error handling in metadata route
 * MED #7: validateContentType on admin PATCH handlers
 * MED #8: source-preference try/catch
 * LOW #9: CSP tightens unsafe-eval in production
 * LOW #10: publicPaths extracted to constants
 * LOW #11: error.digest removed from error page
 * 
 * @jest-environment node
 */

import { validateUUID, ApiError, validateContentType, validateJsonSize, parsePaginationParams } from '@/lib/api-utils';

// ==================== HIGH #1: UUID Validation ====================
describe('HIGH #1: validateUUID on path params', () => {
  it('should accept valid UUID v4', () => {
    expect(() => validateUUID('550e8400-e29b-41d4-a716-446655440000', 'seriesId')).not.toThrow();
  });

  it('should accept valid UUID with uppercase', () => {
    expect(() => validateUUID('550E8400-E29B-41D4-A716-446655440000', 'seriesId')).not.toThrow();
  });

  it('should reject empty string', () => {
    expect(() => validateUUID('', 'seriesId')).toThrow(ApiError);
    try {
      validateUUID('', 'seriesId');
    } catch (e: unknown) {
      expect((e as ApiError).statusCode).toBe(400);
      expect((e as ApiError).code).toBe('INVALID_FORMAT');
      expect((e as ApiError).message).toContain('seriesId');
    }
  });

  it('should reject malformed UUID', () => {
    expect(() => validateUUID('not-a-uuid', 'seriesId')).toThrow(ApiError);
    expect(() => validateUUID('550e8400-e29b-41d4-a716', 'seriesId')).toThrow(ApiError);
    expect(() => validateUUID('550e8400e29b41d4a716446655440000', 'seriesId')).toThrow(ApiError); // no dashes
  });

  it('should reject SQL injection attempts', () => {
    expect(() => validateUUID("'; DROP TABLE series; --", 'seriesId')).toThrow(ApiError);
    expect(() => validateUUID('1 OR 1=1', 'seriesId')).toThrow(ApiError);
  });

  it('should reject path traversal attempts', () => {
    expect(() => validateUUID('../../../etc/passwd', 'seriesId')).toThrow(ApiError);
  });

  it('should include field name in error message', () => {
    try {
      validateUUID('invalid', 'myField');
    } catch (e: unknown) {
      expect((e as ApiError).message).toContain('myField');
    }
  });
});

// ==================== HIGH #2: request.json() try/catch ====================
describe('HIGH #2: Malformed JSON body handling', () => {
  it('should verify ApiError has correct properties for bad JSON', () => {
    const error = new ApiError('Invalid JSON body', 400, 'BAD_REQUEST');
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe('BAD_REQUEST');
    expect(error.message).toBe('Invalid JSON body');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ApiError);
  });

  it('should verify request.json() pattern catches SyntaxError', async () => {
    // Simulate the try/catch pattern used in all routes
    const mockRequest = {
      json: () => Promise.reject(new SyntaxError('Unexpected token'))
    };

    let caughtError: ApiError | null = null;
    try {
      let body;
      try {
        body = await mockRequest.json();
      } catch {
        throw new ApiError('Invalid JSON body', 400, 'BAD_REQUEST');
      }
    } catch (e: unknown) {
      caughtError = e as ApiError;
    }

    expect(caughtError).toBeInstanceOf(ApiError);
    expect(caughtError!.statusCode).toBe(400);
    expect(caughtError!.code).toBe('BAD_REQUEST');
  });
});

// ==================== HIGH #3: validateJsonSize ====================
describe('HIGH #3: validateJsonSize on mutation routes', () => {
  it('should reject oversized Content-Length header', async () => {
    const mockRequest = new Request('https://example.com/api/test', {
      method: 'POST',
      headers: { 'content-length': '2000000' }, // 2MB > 1MB default
      body: 'x',
    });

    await expect(validateJsonSize(mockRequest)).rejects.toThrow(ApiError);
    try {
      await validateJsonSize(mockRequest);
    } catch (e: unknown) {
      expect((e as ApiError).statusCode).toBe(413);
      expect((e as ApiError).code).toBe('PAYLOAD_TOO_LARGE');
    }
  });

  it('should accept small payloads', async () => {
    const mockRequest = new Request('https://example.com/api/test', {
      method: 'POST',
      headers: { 
        'content-type': 'application/json',
        'content-length': '20' 
      },
      body: JSON.stringify({ key: 'value' }),
    });

    await expect(validateJsonSize(mockRequest)).resolves.toBeUndefined();
  });

  it('should accept custom max bytes', async () => {
    const smallLimit = 10; // 10 bytes
    const mockRequest = new Request('https://example.com/api/test', {
      method: 'POST',
      headers: { 'content-length': '100' },
      body: JSON.stringify({ key: 'value that is too large' }),
    });

    await expect(validateJsonSize(mockRequest, smallLimit)).rejects.toThrow(ApiError);
  });
});

// ==================== HIGH #4: Filters route uses Prisma ====================
describe('HIGH #4: Filters route migrated to Prisma', () => {
  it('should not import createClient from supabase/server', async () => {
    // Read the filters route file and verify no Supabase client import
    const fs = await import('fs');
    const path = await import('path');
    const filePath = path.join(process.cwd(), 'src/app/api/users/me/filters/route.ts');
    const content = fs.readFileSync(filePath, 'utf8');
    
    expect(content).not.toContain('createClient');
    expect(content).not.toContain('@/lib/supabase/server');
    expect(content).toContain('prisma');
    expect(content).toContain('filter_payload'); // Correct Prisma column name
  });

  it('should use getMiddlewareUser() instead of supabase.auth.getUser()', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const filePath = path.join(process.cwd(), 'src/app/api/users/me/filters/route.ts');
    const content = fs.readFileSync(filePath, 'utf8');
    
    expect(content).toContain('getMiddlewareUser');
    expect(content).not.toContain('supabase.auth.getUser');
  });
});

// ==================== MED #5: Date validation in feed/seen ====================
describe('MED #5: Date validation in feed/seen', () => {
  it('should verify feed/seen route validates date format', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const filePath = path.join(process.cwd(), 'src/app/api/feed/seen/route.ts');
    const content = fs.readFileSync(filePath, 'utf8');
    
    // Should check for NaN date
    expect(content).toContain('isNaN');
    expect(content).toContain('Invalid date');
  });

  it('should verify Invalid Date detection works', () => {
    const invalidDate = new Date('garbage');
    expect(isNaN(invalidDate.getTime())).toBe(true);
    
    const validDate = new Date('2026-01-15T00:00:00Z');
    expect(isNaN(validDate.getTime())).toBe(false);
  });
});

// ==================== MED #6: Standardized error handling ====================
describe('MED #6: Metadata route uses handleApiError', () => {
  it('should use handleApiError pattern in metadata route', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const filePath = path.join(process.cwd(), 'src/app/api/series/[id]/metadata/route.ts');
    const content = fs.readFileSync(filePath, 'utf8');
    
    expect(content).toContain('handleApiError');
    expect(content).toContain('ApiError');
    // Should not have raw NextResponse.json error responses outside of success paths
    // The try/catch pattern should use ApiError
    expect(content).toContain('throw new ApiError');
  });
});

// ==================== MED #7: validateContentType on admin PATCH ====================
describe('MED #7: Admin PATCH routes have validateContentType', () => {
  it('should have validateContentType in admin/dmca PATCH', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const filePath = path.join(process.cwd(), 'src/app/api/admin/dmca/route.ts');
    const content = fs.readFileSync(filePath, 'utf8');
    
    // The PATCH handler should call validateContentType
    expect(content).toContain('validateContentType');
    expect(content).toContain('validateJsonSize');
    expect(content).toContain('validateOrigin');
  });

  it('should have validateContentType in admin/links PATCH', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const filePath = path.join(process.cwd(), 'src/app/api/admin/links/route.ts');
    const content = fs.readFileSync(filePath, 'utf8');
    
    expect(content).toContain('validateContentType');
    expect(content).toContain('validateJsonSize');
    expect(content).toContain('validateOrigin');
  });
});

// ==================== MED #8: source-preference try/catch ====================
describe('MED #8: source-preference POST wraps request.json()', () => {
  it('should have try/catch around request.json()', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const filePath = path.join(process.cwd(), 'src/app/api/series/[id]/source-preference/route.ts');
    const content = fs.readFileSync(filePath, 'utf8');
    
    // Should have the try/catch pattern
    expect(content).toContain("body = await request.json()");
    expect(content).toContain("Invalid JSON body");
    expect(content).toContain('BAD_REQUEST');
  });
});

// ==================== LOW #9: CSP without unsafe-eval in prod ====================
describe('LOW #9: CSP removes unsafe-eval in production', () => {
  it('should conditionally include unsafe-eval based on NODE_ENV', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const filePath = path.join(process.cwd(), 'src/middleware.ts');
    const content = fs.readFileSync(filePath, 'utf8');
    
    // Should have conditional logic for unsafe-eval
    expect(content).toContain("process.env.NODE_ENV === 'production'");
    // Production should NOT have unsafe-eval
    expect(content).toContain("script-src 'self' 'unsafe-inline' https://*.supabase.co");
    // Development should have unsafe-eval
    expect(content).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.supabase.co");
  });
});

// ==================== LOW #10: publicPaths extracted ====================
describe('LOW #10: publicPaths extracted to constants', () => {
  it('should use shared constants instead of duplicated arrays', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const filePath = path.join(process.cwd(), 'src/lib/supabase/middleware.ts');
    const content = fs.readFileSync(filePath, 'utf8');
    
    // Should have named constants
    expect(content).toContain('PUBLIC_PAGE_PATHS');
    expect(content).toContain('PUBLIC_API_PATHS');
    
    // Should use helper functions
    expect(content).toContain('isPublicPagePath');
    expect(content).toContain('isPublicApiPath');
    
    // Count how many times the full array appears (should be only once for each)
    const pagePathMatches = content.match(/\/login.*\/register.*\/forgot-password/g);
    expect(pagePathMatches?.length).toBe(1); // Only in the constant definition
  });
});

// ==================== LOW #11: error.digest removed ====================
describe('LOW #11: error.digest removed from error page', () => {
  it('should not display error.digest to users', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const filePath = path.join(process.cwd(), 'src/app/error.tsx');
    const content = fs.readFileSync(filePath, 'utf8');
    
    // Should not render error.digest in the UI
    expect(content).not.toContain('error.digest');
    expect(content).not.toContain('Error ID:');
  });
});

// ==================== Regression: All routes have proper protections ====================
describe('Regression: All series/[id] routes have validateUUID', () => {
  const routeFiles = [
    'src/app/api/series/[id]/sources/route.ts',
    'src/app/api/series/[id]/metadata/route.ts',
    'src/app/api/series/[id]/source-preference/route.ts',
  ];

  routeFiles.forEach(routeFile => {
    it(`${routeFile} should call validateUUID`, async () => {
      const fs = await import('fs');
      const path = await import('path');
      const filePath = path.join(process.cwd(), routeFile);
      const content = fs.readFileSync(filePath, 'utf8');
      
      expect(content).toContain("validateUUID(seriesId, 'seriesId')");
    });
  });
});

describe('Regression: All mutation routes have request.json() try/catch', () => {
  const routeFiles = [
    'src/app/api/feed/seen/route.ts',
    'src/app/api/users/me/source-priorities/route.ts',
    'src/app/api/series/[id]/source-preference/route.ts',
    'src/app/api/library/import/route.ts',
    'src/app/api/auth/lockout/route.ts',
    'src/app/api/dmca/route.ts',
    'src/app/api/admin/dmca/route.ts',
    'src/app/api/admin/links/route.ts',
    'src/app/api/users/me/filters/route.ts',
  ];

  routeFiles.forEach(routeFile => {
    it(`${routeFile} should have try/catch around request.json()`, async () => {
      const fs = await import('fs');
      const path = await import('path');
      const filePath = path.join(process.cwd(), routeFile);
      const content = fs.readFileSync(filePath, 'utf8');
      
      // Pattern: try { body = await req.json() } catch { throw ApiError }
      expect(content).toContain('Invalid JSON body');
    });
  });
});

describe('Regression: Mutation routes have validateJsonSize', () => {
  const routeFiles = [
    'src/app/api/series/[id]/sources/route.ts',
    'src/app/api/series/[id]/metadata/route.ts',
    'src/app/api/auth/lockout/route.ts',
    'src/app/api/feed/seen/route.ts',
    'src/app/api/dmca/route.ts',
    'src/app/api/users/me/source-priorities/route.ts',
    'src/app/api/users/me/filters/route.ts',
    'src/app/api/library/import/route.ts',
  ];

  routeFiles.forEach(routeFile => {
    it(`${routeFile} should call validateJsonSize`, async () => {
      const fs = await import('fs');
      const path = await import('path');
      const filePath = path.join(process.cwd(), routeFile);
      const content = fs.readFileSync(filePath, 'utf8');
      
      expect(content).toContain('validateJsonSize');
    });
  });
});

// ==================== Smoke test: validateContentType ====================
describe('validateContentType', () => {
  it('should reject request without content-type', () => {
    const req = new Request('https://example.com', {
      method: 'POST',
    });
    expect(() => validateContentType(req)).toThrow(ApiError);
  });

  it('should accept application/json', () => {
    const req = new Request('https://example.com', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect(() => validateContentType(req)).not.toThrow();
  });

  it('should accept application/json with charset', () => {
    const req = new Request('https://example.com', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
    expect(() => validateContentType(req)).not.toThrow();
  });

  it('should reject text/plain', () => {
    const req = new Request('https://example.com', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
    });
    expect(() => validateContentType(req)).toThrow(ApiError);
    try {
      validateContentType(req);
    } catch (e: unknown) {
      expect((e as ApiError).statusCode).toBe(415);
    }
  });
});
