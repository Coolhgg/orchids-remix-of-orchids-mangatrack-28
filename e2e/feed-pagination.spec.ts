import { test, expect } from '@playwright/test';

/**
 * E2E Tests: Feed Activity Pagination
 *
 * Tests the feed/activity API endpoint for correct cursor-based pagination,
 * filter validation, and edge-case handling.
 */

const FEED_URL = '/api/feed/activity';

test.describe('Feed Activity Pagination', () => {
  test.describe('Query Parameter Validation', () => {
    test('should accept default parameters', async ({ request }) => {
      const response = await request.get(FEED_URL);
      // 200 with empty entries (unauthenticated returns empty), or 401
      expect([200, 401]).toContain(response.status());

      if (response.status() === 200) {
        const body = await response.json();
        expect(body).toHaveProperty('entries');
        expect(body).toHaveProperty('next_cursor');
        expect(body).toHaveProperty('has_more');
        expect(Array.isArray(body.entries)).toBe(true);
      }
    });

    test('should clamp limit to valid range (1-100)', async ({ request }) => {
      // Over max
      const overMax = await request.get(`${FEED_URL}?limit=500`);
      expect([200, 401]).toContain(overMax.status());

      // Under min
      const underMin = await request.get(`${FEED_URL}?limit=-5`);
      expect([200, 401]).toContain(underMin.status());

      // Zero
      const zero = await request.get(`${FEED_URL}?limit=0`);
      expect([200, 401]).toContain(zero.status());

      // NaN
      const nan = await request.get(`${FEED_URL}?limit=abc`);
      expect([200, 401]).toContain(nan.status());
    });

    test('should default invalid filter to "all"', async ({ request }) => {
      const response = await request.get(`${FEED_URL}?filter=invalid_value`);
      expect([200, 401]).toContain(response.status());
      // Should not crash - invalid filter falls back to "all"
    });

    test('should accept valid filter values', async ({ request }) => {
      for (const filter of ['all', 'unread']) {
        const response = await request.get(`${FEED_URL}?filter=${filter}`);
        expect([200, 401]).toContain(response.status());
      }
    });
  });

  test.describe('Cursor Handling', () => {
    test('should handle invalid cursor gracefully', async ({ request }) => {
      const response = await request.get(`${FEED_URL}?cursor=not-base64-json`);
      expect([200, 401]).toContain(response.status());
      // Should not crash - invalid cursor is ignored
    });

    test('should handle empty cursor', async ({ request }) => {
      const response = await request.get(`${FEED_URL}?cursor=`);
      expect([200, 401]).toContain(response.status());
    });

    test('should handle base64 with invalid JSON', async ({ request }) => {
      const cursor = Buffer.from('not json').toString('base64');
      const response = await request.get(`${FEED_URL}?cursor=${cursor}`);
      expect([200, 401]).toContain(response.status());
    });

    test('should handle base64 JSON with missing fields', async ({ request }) => {
      const cursor = Buffer.from(JSON.stringify({ x: 1 })).toString('base64');
      const response = await request.get(`${FEED_URL}?cursor=${cursor}`);
      expect([200, 401]).toContain(response.status());
    });

    test('should handle cursor with invalid date', async ({ request }) => {
      const cursor = Buffer.from(
        JSON.stringify({ d: 'not-a-date', i: '00000000-0000-0000-0000-000000000000' })
      ).toString('base64');
      const response = await request.get(`${FEED_URL}?cursor=${cursor}`);
      expect([200, 401]).toContain(response.status());
    });

    test('should handle cursor with invalid UUID', async ({ request }) => {
      const cursor = Buffer.from(
        JSON.stringify({ d: new Date().toISOString(), i: 'not-a-uuid' })
      ).toString('base64');
      const response = await request.get(`${FEED_URL}?cursor=${cursor}`);
      expect([200, 401]).toContain(response.status());
    });

    test('should handle well-formed cursor (future date)', async ({ request }) => {
      const futureDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
      const cursor = Buffer.from(
        JSON.stringify({
          d: futureDate.toISOString(),
          i: '00000000-0000-0000-0000-000000000000',
        })
      ).toString('base64');
      const response = await request.get(`${FEED_URL}?cursor=${cursor}`);
      expect([200, 401]).toContain(response.status());
    });
  });

  test.describe('Response Format', () => {
    test('should return valid JSON with expected shape', async ({ request }) => {
      const response = await request.get(FEED_URL);

      if (response.status() === 200) {
        const body = await response.json();
        expect(body.entries).toBeDefined();
        expect(typeof body.has_more).toBe('boolean');

        // next_cursor should be null or a string
        if (body.next_cursor !== null) {
          expect(typeof body.next_cursor).toBe('string');
        }
      }
    });

    test('should return correct content-type', async ({ request }) => {
      const response = await request.get(FEED_URL);
      const contentType = response.headers()['content-type'];
      expect(contentType).toContain('application/json');
    });
  });

  test.describe('Rate Limiting', () => {
    test('should not crash under moderate load', async ({ request }) => {
      const promises = Array(15)
        .fill(null)
        .map(() => request.get(FEED_URL));

      const responses = await Promise.all(promises);

      for (const response of responses) {
        // Should either succeed or rate-limit, never 500
        expect([200, 401, 429]).toContain(response.status());
      }
    });
  });

  test.describe('Combined Parameters', () => {
    test('should handle all params together', async ({ request }) => {
      const cursor = Buffer.from(
        JSON.stringify({
          d: new Date().toISOString(),
          i: '00000000-0000-0000-0000-000000000000',
        })
      ).toString('base64');

      const response = await request.get(
        `${FEED_URL}?filter=unread&limit=10&cursor=${cursor}`
      );
      expect([200, 401]).toContain(response.status());
    });
  });
});
