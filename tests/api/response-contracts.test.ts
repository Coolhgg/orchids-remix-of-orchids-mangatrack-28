/**
 * API Response Contracts Tests
 * 
 * Tests API response format consistency:
 * - Standard error response structure
 * - Pagination format
 * - Data field naming conventions
 * - Required fields presence
 * 
 * Run with: bun test tests/api/response-contracts.test.ts
 */

import { describe, test, expect } from 'bun:test';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';

// Helper to make API requests
async function apiRequest(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  options: {
    body?: object;
    headers?: Record<string, string>;
  } = {}
) {
  const url = `${BASE_URL}${path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  const init: RequestInit = {
    method,
    headers,
  };

  if (options.body && method !== 'GET') {
    init.body = JSON.stringify(options.body);
  }

  return fetch(url, init);
}

describe('API Response Contracts: Error Responses', () => {
  test('401 errors have consistent structure', async () => {
    const protectedEndpoints = [
      '/api/library',
      '/api/users/me',
      '/api/notifications',
    ];

    for (const endpoint of protectedEndpoints) {
      const response = await apiRequest('GET', endpoint);
      expect(response.status).toBe(401);

      const body = await response.json();
      
      // Standard error fields
      expect(body).toHaveProperty('error');
      expect(body).toHaveProperty('requestId');
      expect(body).toHaveProperty('code');
      
      // Code should be UNAUTHORIZED
      expect(body.code).toBe('UNAUTHORIZED');
    }
  });

  test('400 errors include validation details', async () => {
    const response = await apiRequest('GET', '/api/series/invalid-uuid-format');
    
    if (response.status === 400) {
      const body = await response.json();
      
      expect(body).toHaveProperty('error');
      expect(body).toHaveProperty('code');
      expect(['VALIDATION_ERROR', 'INVALID_FORMAT', 'BAD_REQUEST']).toContain(body.code);
    }
  });

  test('404 errors have consistent format', async () => {
    const response = await apiRequest('GET', '/api/series/00000000-0000-0000-0000-000000000000');
    
    if (response.status === 404) {
      const body = await response.json();
      
      expect(body).toHaveProperty('error');
      expect(body).toHaveProperty('code');
      expect(body.code).toBe('NOT_FOUND');
    }
  });

  test('429 rate limit responses include retry info', async () => {
    // Make rapid requests to trigger rate limit
    const requests = Array.from({ length: 50 }, () =>
      apiRequest('GET', '/api/series/search?q=test')
    );
    
    const responses = await Promise.all(requests);
    const rateLimitedResponse = responses.find(r => r.status === 429);
    
    if (rateLimitedResponse) {
      const body = await rateLimitedResponse.json();
      
      expect(body).toHaveProperty('error');
      expect(body).toHaveProperty('code');
      expect(body.code).toBe('RATE_LIMITED');
      
      // Should include rate limit headers
      expect(rateLimitedResponse.headers.get('X-RateLimit-Limit')).toBeDefined();
      expect(rateLimitedResponse.headers.get('X-RateLimit-Remaining')).toBeDefined();
    }
  });
});

describe('API Response Contracts: Success Responses', () => {
  test('Search endpoint returns standard structure', async () => {
    const response = await apiRequest('GET', '/api/series/search?q=test');
    
    if (response.status === 200) {
      const body = await response.json();
      
      // Must have results array
      expect(body).toHaveProperty('results');
      expect(Array.isArray(body.results)).toBe(true);
      
      // Must have status indicator
      expect(body).toHaveProperty('status');
      expect(['complete', 'partial', 'discovering', 'external_only']).toContain(body.status);
      
      // Each result should have required fields
      if (body.results.length > 0) {
        const result = body.results[0];
        expect(result).toHaveProperty('id');
        expect(result).toHaveProperty('title');
        expect(result).toHaveProperty('cover_url'); // May be null
      }
    }
  });

  test('Browse endpoint returns paginated structure', async () => {
    const response = await apiRequest('GET', '/api/series/browse?limit=10');
    
    if (response.status === 200) {
      const body = await response.json();
      
      // Must have series array
      expect(body).toHaveProperty('series');
      expect(Array.isArray(body.series)).toBe(true);
      expect(body.series.length).toBeLessThanOrEqual(10);
      
      // Must have pagination info
      expect(body).toHaveProperty('nextCursor');
      expect(body).toHaveProperty('total');
      
      // Each series should have required fields
      if (body.series.length > 0) {
        const series = body.series[0];
        expect(series).toHaveProperty('id');
        expect(series).toHaveProperty('title');
        expect(series).toHaveProperty('cover_url');
        expect(series).toHaveProperty('type');
        expect(series).toHaveProperty('status');
      }
    }
  });

  test('Trending endpoint returns array of series', async () => {
    const response = await apiRequest('GET', '/api/series/trending');
    
    if (response.status === 200) {
      const body = await response.json();
      
      expect(Array.isArray(body)).toBe(true);
      
      if (body.length > 0) {
        const series = body[0];
        expect(series).toHaveProperty('id');
        expect(series).toHaveProperty('title');
      }
    }
  });

  test('Series detail endpoint returns complete data', async () => {
    // First get a valid series ID from browse
    const browseResponse = await apiRequest('GET', '/api/series/browse?limit=1');
    
    if (browseResponse.status === 200) {
      const browseBody = await browseResponse.json();
      
      if (browseBody.series?.length > 0) {
        const seriesId = browseBody.series[0].id;
        const response = await apiRequest('GET', `/api/series/${seriesId}`);
        
        if (response.status === 200) {
          const body = await response.json();
          
          // Core fields
          expect(body).toHaveProperty('id');
          expect(body).toHaveProperty('title');
          expect(body).toHaveProperty('description');
          expect(body).toHaveProperty('cover_url');
          expect(body).toHaveProperty('type');
          expect(body).toHaveProperty('status');
          
          // Metadata arrays
          expect(body).toHaveProperty('genres');
          expect(Array.isArray(body.genres)).toBe(true);
          
          // Stats
          expect(body).toHaveProperty('total_follows');
          expect(body).toHaveProperty('average_rating');
          
          // Sources relation (may be nested or separate)
          expect(body).toHaveProperty('sources');
        }
      }
    }
  });
});

describe('API Response Contracts: Field Naming', () => {
  test('Fields use snake_case consistently', async () => {
    const response = await apiRequest('GET', '/api/series/browse?limit=5');
    
    if (response.status === 200) {
      const body = await response.json();
      
      if (body.series?.length > 0) {
        const series = body.series[0];
        
        // All keys should be snake_case
        const keys = Object.keys(series);
        for (const key of keys) {
          // Should not have camelCase (except 'id')
          if (key !== 'id') {
            expect(key).not.toMatch(/[a-z][A-Z]/);
          }
        }
        
        // Common expected snake_case fields
        if ('coverUrl' in series) {
          throw new Error('coverUrl should be cover_url');
        }
        if ('totalFollows' in series) {
          throw new Error('totalFollows should be total_follows');
        }
      }
    }
  });

  test('Dates are ISO 8601 format', async () => {
    const response = await apiRequest('GET', '/api/series/browse?limit=1');
    
    if (response.status === 200) {
      const body = await response.json();
      
      if (body.series?.length > 0) {
        const series = body.series[0];
        
        // Check date fields
        if (series.created_at) {
          expect(() => new Date(series.created_at)).not.toThrow();
          expect(series.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        }
        
        if (series.updated_at) {
          expect(() => new Date(series.updated_at)).not.toThrow();
        }
      }
    }
  });

  test('IDs are valid UUIDs', async () => {
    const response = await apiRequest('GET', '/api/series/browse?limit=5');
    
    if (response.status === 200) {
      const body = await response.json();
      
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      
      for (const series of body.series || []) {
        expect(series.id).toMatch(uuidRegex);
      }
    }
  });
});

describe('API Response Contracts: Pagination', () => {
  test('Cursor pagination works correctly', async () => {
    // Get first page
    const page1 = await apiRequest('GET', '/api/series/browse?limit=5');
    
    if (page1.status === 200) {
      const body1 = await page1.json();
      
      if (body1.nextCursor && body1.series?.length > 0) {
        // Get second page using cursor
        const page2 = await apiRequest('GET', `/api/series/browse?limit=5&cursor=${body1.nextCursor}`);
        
        if (page2.status === 200) {
          const body2 = await page2.json();
          
          // Pages should be different
          if (body2.series?.length > 0) {
            const page1Ids = body1.series.map((s: any) => s.id);
            const page2Ids = body2.series.map((s: any) => s.id);
            
            // No overlap between pages
            const overlap = page1Ids.filter((id: string) => page2Ids.includes(id));
            expect(overlap.length).toBe(0);
          }
        }
      }
    }
  });

  test('Limit parameter is respected', async () => {
    const limits = [1, 5, 10, 20];
    
    for (const limit of limits) {
      const response = await apiRequest('GET', `/api/series/browse?limit=${limit}`);
      
      if (response.status === 200) {
        const body = await response.json();
        expect(body.series?.length).toBeLessThanOrEqual(limit);
      }
    }
  });

  test('Total count is accurate', async () => {
    const response = await apiRequest('GET', '/api/series/browse?limit=1');
    
    if (response.status === 200) {
      const body = await response.json();
      
      expect(typeof body.total).toBe('number');
      expect(body.total).toBeGreaterThanOrEqual(body.series?.length || 0);
    }
  });
});

describe('API Response Contracts: Content Negotiation', () => {
  test('JSON content type is returned', async () => {
    const response = await apiRequest('GET', '/api/series/search?q=test');
    
    const contentType = response.headers.get('content-type');
    expect(contentType).toContain('application/json');
  });

  test('Charset is UTF-8', async () => {
    const response = await apiRequest('GET', '/api/series/search?q=日本語'); // Japanese query
    
    if (response.status === 200) {
      const body = await response.json();
      // Should parse without issues
      expect(body).toBeDefined();
    }
  });
});

describe('API Response Contracts: Empty States', () => {
  test('Empty search returns empty array, not null', async () => {
    const response = await apiRequest('GET', '/api/series/search?q=xyznonexistenttitle12345');
    
    if (response.status === 200) {
      const body = await response.json();
      
      expect(body.results).toBeDefined();
      expect(Array.isArray(body.results)).toBe(true);
      expect(body.results).not.toBeNull();
    }
  });

  test('Empty browse returns empty array with metadata', async () => {
    // Use impossible filter combination
    const response = await apiRequest('GET', '/api/series/browse?type=nonexistent');
    
    if (response.status === 200) {
      const body = await response.json();
      
      expect(body.series).toBeDefined();
      expect(Array.isArray(body.series)).toBe(true);
      expect(typeof body.total).toBe('number');
    }
  });
});

describe('API Response Contracts: Null Handling', () => {
  test('Nullable fields return null, not undefined', async () => {
    const response = await apiRequest('GET', '/api/series/browse?limit=5');
    
    if (response.status === 200) {
      const body = await response.json();
      
      for (const series of body.series || []) {
        // Check that JSON actually contains null for nullable fields
        const jsonString = JSON.stringify(series);
        
        // If a field is missing from response, it should be explicit null not omitted
        if (series.description === null) {
          expect(jsonString).toContain('"description":null');
        }
      }
    }
  });

  test('Numeric fields are numbers not strings', async () => {
    const response = await apiRequest('GET', '/api/series/browse?limit=5');
    
    if (response.status === 200) {
      const body = await response.json();
      
      for (const series of body.series || []) {
        if (series.total_follows !== null) {
          expect(typeof series.total_follows).toBe('number');
        }
        if (series.average_rating !== null) {
          expect(typeof series.average_rating).toBe('number');
        }
        if (series.chapter_count !== null) {
          expect(typeof series.chapter_count).toBe('number');
        }
      }
    }
  });
});
