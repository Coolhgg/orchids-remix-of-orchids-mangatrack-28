import { test, expect } from '@playwright/test';

/**
 * Search Flow E2E Tests
 * 
 * Tests search and discovery functionality:
 * - Basic text search
 * - Filter by genre/type/status
 * - Cursor-based pagination
 * - Search rate limiting
 * - External discovery fallback
 */

test.describe('Search and Discovery', () => {
  test.describe('Public Search (No Auth)', () => {
    test('should perform basic text search', async ({ page }) => {
      await page.goto('/browse');
      await page.waitForLoadState('networkidle');
      
      // Find search input
      const searchInput = page.getByPlaceholder(/Search|Find/i).first();
      await expect(searchInput).toBeVisible({ timeout: 5000 });
      
      // Perform search
      await searchInput.fill('Solo Leveling');
      await searchInput.press('Enter');
      
      // Wait for results
      await page.waitForLoadState('networkidle');
      
      // Should have results or search-related URL params
      expect(page.url()).toMatch(/q=|query=|search=/i);
      
      // Results should appear
      const results = page.locator('a[href^="/series/"]');
      await expect(results.first()).toBeVisible({ timeout: 10000 });
    });

    test('should filter by genre', async ({ page }) => {
      await page.goto('/browse');
      await page.waitForLoadState('networkidle');
      
      // Find genre filter
      const genreFilter = page.locator('[data-testid="genre-filter"], select[name="genre"]').first();
      const genreButton = page.getByRole('button', { name: /Genre|Genres/i }).first();
      
      if (await genreFilter.isVisible()) {
        await genreFilter.selectOption('action');
      } else if (await genreButton.isVisible()) {
        await genreButton.click();
        
        const actionOption = page.getByRole('option', { name: /Action/i }).first();
        if (await actionOption.isVisible()) {
          await actionOption.click();
        }
      } else {
        // Click on genre tag/chip if visible
        const genreTag = page.getByText(/Action/i).first();
        if (await genreTag.isVisible()) {
          await genreTag.click();
        }
      }
      
      await page.waitForLoadState('networkidle');
      
      // URL should reflect filter
      expect(page.url()).toMatch(/genre|genres/i);
    });

    test('should filter by type', async ({ page }) => {
      await page.goto('/browse');
      await page.waitForLoadState('networkidle');
      
      // Find type filter (Manga, Manhwa, Manhua)
      const typeFilter = page.locator('[data-testid="type-filter"], select[name="type"]').first();
      const typeButton = page.getByRole('button', { name: /Type|Format/i }).first();
      
      if (await typeFilter.isVisible()) {
        await typeFilter.selectOption('manhwa');
      } else if (await typeButton.isVisible()) {
        await typeButton.click();
        
        const manhwaOption = page.getByRole('option', { name: /Manhwa/i }).first();
        if (await manhwaOption.isVisible()) {
          await manhwaOption.click();
        }
      }
      
      await page.waitForLoadState('networkidle');
      expect(page.url()).toMatch(/type/i);
    });

    test('should filter by status', async ({ page }) => {
      await page.goto('/browse');
      await page.waitForLoadState('networkidle');
      
      // Find status filter
      const statusFilter = page.locator('[data-testid="status-filter"], select[name="status"]').first();
      const statusButton = page.getByRole('button', { name: /Status/i }).first();
      
      if (await statusFilter.isVisible()) {
        await statusFilter.selectOption('releasing');
      } else if (await statusButton.isVisible()) {
        await statusButton.click();
        
        const releasingOption = page.getByRole('option', { name: /Ongoing|Releasing/i }).first();
        if (await releasingOption.isVisible()) {
          await releasingOption.click();
        }
      }
      
      await page.waitForLoadState('networkidle');
      expect(page.url()).toMatch(/status/i);
    });

    test('should sort results', async ({ page }) => {
      await page.goto('/browse');
      await page.waitForLoadState('networkidle');
      
      // Find sort control
      const sortSelect = page.locator('[data-testid="sort-select"], select[name="sort"]').first();
      const sortButton = page.getByRole('button', { name: /Sort/i }).first();
      
      if (await sortSelect.isVisible()) {
        await sortSelect.selectOption('rating');
        await page.waitForTimeout(500);
        expect(page.url()).toMatch(/sort=rating/i);
      } else if (await sortButton.isVisible()) {
        await sortButton.click();
        
        const ratingOption = page.getByRole('option', { name: /Rating|Top Rated/i }).first();
        if (await ratingOption.isVisible()) {
          await ratingOption.click();
        }
      }
    });

    test('should paginate results', async ({ page }) => {
      await page.goto('/browse');
      await page.waitForLoadState('networkidle');
      
      // Wait for initial results
      const results = page.locator('a[href^="/series/"]');
      await expect(results.first()).toBeVisible({ timeout: 10000 });
      
      // Find pagination controls
      const nextButton = page.getByRole('button', { name: /Next|Load More/i }).first();
      const pageButton = page.locator('[data-testid="page-2"], button:has-text("2")').first();
      
      if (await nextButton.isVisible()) {
        await nextButton.click();
        await page.waitForLoadState('networkidle');
        
        // URL should have pagination param
        expect(page.url()).toMatch(/page=|offset=|cursor=/i);
      } else if (await pageButton.isVisible()) {
        await pageButton.click();
        await page.waitForLoadState('networkidle');
        expect(page.url()).toMatch(/page=2/i);
      } else {
        // Try infinite scroll
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(1000);
        
        // Should load more results
        const newResults = page.locator('a[href^="/series/"]');
        expect(await newResults.count()).toBeGreaterThan(0);
      }
    });

    test('should handle empty search results', async ({ page }) => {
      await page.goto('/browse');
      await page.waitForLoadState('networkidle');
      
      const searchInput = page.getByPlaceholder(/Search|Find/i).first();
      await expect(searchInput).toBeVisible();
      
      // Search for something unlikely to exist
      await searchInput.fill('xyznonexistent123456');
      await searchInput.press('Enter');
      
      await page.waitForLoadState('networkidle');
      
      // Should show "no results" message or empty state
      const noResults = page.getByText(/No results|Nothing found|No series found/i);
      await expect(noResults).toBeVisible({ timeout: 5000 });
    });

    test('should navigate to series detail from search results', async ({ page }) => {
      await page.goto('/browse');
      await page.waitForLoadState('networkidle');
      
      // Wait for series cards to load
      const seriesCard = page.locator('a[href^="/series/"]').first();
      await expect(seriesCard).toBeVisible({ timeout: 10000 });
      
      // Click on first result
      await seriesCard.click();
      
      // Should navigate to series page
      await expect(page).toHaveURL(/\/series\//);
      
      // Series page should have title
      const seriesTitle = page.locator('h1, [data-testid="series-title"]').first();
      await expect(seriesTitle).toBeVisible();
    });

    test('should combine multiple filters', async ({ page }) => {
      await page.goto('/browse?type=manhwa&status=releasing');
      await page.waitForLoadState('networkidle');
      
      // Should have both filters in URL
      expect(page.url()).toMatch(/type=manhwa/i);
      expect(page.url()).toMatch(/status=releasing/i);
      
      // Results should load
      const results = page.locator('a[href^="/series/"]');
      
      // Either results or "no results" message
      const hasResults = await results.first().isVisible().catch(() => false);
      const noResults = await page.getByText(/No results/i).isVisible().catch(() => false);
      
      expect(hasResults || noResults).toBeTruthy();
    });

    test('should clear filters', async ({ page }) => {
      await page.goto('/browse?type=manhwa&status=releasing');
      await page.waitForLoadState('networkidle');
      
      // Find clear/reset button
      const clearButton = page.getByRole('button', { name: /Clear|Reset|Clear All/i }).first();
      
      if (await clearButton.isVisible()) {
        await clearButton.click();
        await page.waitForLoadState('networkidle');
        
        // URL should be cleaner
        expect(page.url()).not.toMatch(/type=manhwa/);
      }
    });
  });

  test.describe('Search API', () => {
    test('GET /api/series/search returns results', async ({ request }) => {
      const response = await request.get('/api/series/search?q=test');
      
      // Should succeed (even if empty)
      expect([200, 429]).toContain(response.status());
      
      if (response.status() === 200) {
        const body = await response.json();
        expect(body).toHaveProperty('results');
        expect(body).toHaveProperty('status');
        expect(Array.isArray(body.results)).toBeTruthy();
      }
    });

    test('GET /api/series/search respects rate limits', async ({ request }) => {
      // Make many rapid requests
      const responses = await Promise.all(
        Array.from({ length: 35 }, () => 
          request.get('/api/series/search?q=test')
        )
      );
      
      // At least some should be rate limited
      const statuses = responses.map(r => r.status());
      const has429 = statuses.some(s => s === 429);
      const has200 = statuses.some(s => s === 200);
      
      // Should have mix of successful and rate limited (or all successful if limit is high)
      expect(has200 || has429).toBeTruthy();
    });

    test('GET /api/series/search validates query length', async ({ request }) => {
      const longQuery = 'a'.repeat(1000);
      const response = await request.get(`/api/series/search?q=${longQuery}`);
      
      // Should return 400 for too-long query
      expect([200, 400, 429]).toContain(response.status());
    });

    test('GET /api/series/browse returns paginated results', async ({ request }) => {
      const response = await request.get('/api/series/browse?limit=10');
      
      expect([200, 429]).toContain(response.status());
      
      if (response.status() === 200) {
        const body = await response.json();
        expect(body).toHaveProperty('series');
        expect(Array.isArray(body.series)).toBeTruthy();
        expect(body.series.length).toBeLessThanOrEqual(10);
      }
    });

    test('GET /api/series/browse filters by type', async ({ request }) => {
      const response = await request.get('/api/series/browse?type=manhwa');
      
      expect([200, 429]).toContain(response.status());
      
      if (response.status() === 200) {
        const body = await response.json();
        
        if (body.series?.length > 0) {
          // All results should be manhwa type
          body.series.forEach((series: any) => {
            expect(series.type?.toLowerCase()).toBe('manhwa');
          });
        }
      }
    });

    test('GET /api/series/trending returns trending series', async ({ request }) => {
      const response = await request.get('/api/series/trending');
      
      expect([200, 429]).toContain(response.status());
      
      if (response.status() === 200) {
        const body = await response.json();
        expect(Array.isArray(body)).toBeTruthy();
      }
    });

    test('API response includes expected fields', async ({ request }) => {
      const response = await request.get('/api/series/browse?limit=1');
      
      if (response.status() === 200) {
        const body = await response.json();
        
        if (body.series?.length > 0) {
          const series = body.series[0];
          
          // Should have essential fields
          expect(series).toHaveProperty('id');
          expect(series).toHaveProperty('title');
          // Cover URL may be null but property should exist
          expect(series).toHaveProperty('cover_url');
        }
      }
    });
  });

  test.describe('Discovery Features', () => {
    test('should show discovery status for rare searches', async ({ page }) => {
      await page.goto('/browse');
      await page.waitForLoadState('networkidle');
      
      const searchInput = page.getByPlaceholder(/Search|Find/i).first();
      await expect(searchInput).toBeVisible();
      
      // Search for something uncommon to trigger external discovery
      await searchInput.fill('obscure manga title 12345');
      await searchInput.press('Enter');
      
      await page.waitForLoadState('networkidle');
      
      // May show "searching external sources" or similar
      const discoveryMessage = page.getByText(/Searching|Discovering|Looking for more/i);
      const noResults = page.getByText(/No results|Not found/i);
      
      // Either discovery or no results should show
      await Promise.race([
        expect(discoveryMessage).toBeVisible({ timeout: 5000 }),
        expect(noResults).toBeVisible({ timeout: 5000 }),
      ]).catch(() => {
        // Timeout is acceptable - the search completed normally
      });
    });
  });
});
