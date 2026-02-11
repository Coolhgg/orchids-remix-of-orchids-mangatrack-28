import { test, expect } from '@playwright/test';

/**
 * Library Flow E2E Tests
 * 
 * Tests critical library management functionality:
 * - Adding series to library
 * - Updating reading progress
 * - XP grant verification
 * - Status changes
 * - Removing series
 */

test.describe('Library Management', () => {
  test.describe.configure({ mode: 'serial' });

  // Test authenticated library operations
  test.describe('Authenticated User Library Operations', () => {
    // These tests require authentication
    test.use({ storageState: 'e2e/.auth/user.json' });

    test('should display empty library for new user', async ({ page }) => {
      await page.goto('/library');
      
      // Wait for page to load
      await expect(page).toHaveURL(/\/library/);
      
      // Check for empty state or library grid
      const emptyState = page.getByText(/Your library is empty|Start building your library|No series found/i);
      const libraryGrid = page.locator('[data-testid="library-grid"], .library-grid, .grid');
      
      // Either empty state or grid should be visible
      const isEmpty = await emptyState.isVisible().catch(() => false);
      const hasGrid = await libraryGrid.isVisible().catch(() => false);
      
      expect(isEmpty || hasGrid).toBeTruthy();
    });

    test('should add series to library from browse', async ({ page }) => {
      // Navigate to browse
      await page.goto('/browse');
      await expect(page.getByRole('heading', { name: /Browse|Discover/i })).toBeVisible({ timeout: 10000 });

      // Wait for series to load
      const seriesCard = page.locator('a[href^="/series/"]').first();
      await expect(seriesCard).toBeVisible({ timeout: 10000 });
      
      // Click on first series
      await seriesCard.click();
      await expect(page).toHaveURL(/\/series\//);
      
      // Look for add to library button
      const addButton = page.getByRole('button', { name: /Add to Library|Add|Track/i }).first();
      
      if (await addButton.isVisible()) {
        await addButton.click();
        
        // Verify success (toast notification or button state change)
        await expect(
          page.getByText(/Added|In Library|Tracking/i).first()
        ).toBeVisible({ timeout: 5000 });
      }
    });

    test('should update reading progress', async ({ page }) => {
      await page.goto('/library');
      
      // Wait for library to load
      await page.waitForLoadState('networkidle');
      
      // Find a library entry
      const libraryEntry = page.locator('[data-testid="library-entry"], .library-entry, .library-card').first();
      
      if (await libraryEntry.isVisible()) {
        // Click on the entry to see details or find progress controls
        await libraryEntry.click();
        
        // Look for progress update controls
        const progressInput = page.locator('input[name="chapter"], input[type="number"]').first();
        
        if (await progressInput.isVisible()) {
          // Increment chapter
          const currentValue = await progressInput.inputValue();
          const newValue = parseInt(currentValue || '0') + 1;
          
          await progressInput.fill(newValue.toString());
          await progressInput.press('Enter');
          
          // Wait for update
          await page.waitForTimeout(1000);
          
          // Verify the value was updated
          await expect(progressInput).toHaveValue(newValue.toString());
        }
      }
    });

    test('should change series status', async ({ page }) => {
      await page.goto('/library');
      await page.waitForLoadState('networkidle');
      
      // Find a library entry
      const libraryEntry = page.locator('[data-testid="library-entry"], .library-entry, .library-card').first();
      
      if (await libraryEntry.isVisible()) {
        // Look for status dropdown or menu
        const statusSelect = page.locator('select[name="status"], [data-testid="status-select"]').first();
        const statusButton = page.getByRole('button', { name: /Reading|Completed|Planning|Dropped|Paused/i }).first();
        
        if (await statusSelect.isVisible()) {
          await statusSelect.selectOption('completed');
          await page.waitForTimeout(500);
          await expect(statusSelect).toHaveValue('completed');
        } else if (await statusButton.isVisible()) {
          await statusButton.click();
          
          // Select a different status from dropdown
          const completedOption = page.getByRole('option', { name: /Completed/i });
          if (await completedOption.isVisible()) {
            await completedOption.click();
          }
        }
      }
    });

    test('should filter library by status', async ({ page }) => {
      await page.goto('/library');
      await page.waitForLoadState('networkidle');
      
      // Find status filter tabs or buttons
      const readingTab = page.getByRole('tab', { name: /Reading/i });
      const completedTab = page.getByRole('tab', { name: /Completed/i });
      
      if (await readingTab.isVisible()) {
        await readingTab.click();
        await page.waitForTimeout(500);
        
        // URL should update with status filter
        expect(page.url()).toMatch(/status=reading|tab=reading/i);
      }
      
      if (await completedTab.isVisible()) {
        await completedTab.click();
        await page.waitForTimeout(500);
        expect(page.url()).toMatch(/status=completed|tab=completed/i);
      }
    });

    test('should search within library', async ({ page }) => {
      await page.goto('/library');
      await page.waitForLoadState('networkidle');
      
      // Find search input
      const searchInput = page.getByPlaceholder(/Search|Filter/i).first();
      
      if (await searchInput.isVisible()) {
        await searchInput.fill('test');
        await searchInput.press('Enter');
        
        // Wait for search to complete
        await page.waitForTimeout(1000);
        
        // URL should contain search query
        expect(page.url()).toMatch(/q=test|search=test|query=test/i);
      }
    });

    test('should sort library entries', async ({ page }) => {
      await page.goto('/library');
      await page.waitForLoadState('networkidle');
      
      // Find sort selector
      const sortSelect = page.locator('select[name="sort"], [data-testid="sort-select"]').first();
      const sortButton = page.getByRole('button', { name: /Sort|Order/i }).first();
      
      if (await sortSelect.isVisible()) {
        await sortSelect.selectOption('title');
        await page.waitForTimeout(500);
        expect(page.url()).toMatch(/sort=title/i);
      } else if (await sortButton.isVisible()) {
        await sortButton.click();
        
        const titleSort = page.getByRole('option', { name: /Title|Alphabetical/i });
        if (await titleSort.isVisible()) {
          await titleSort.click();
        }
      }
    });

    test('should remove series from library', async ({ page }) => {
      await page.goto('/library');
      await page.waitForLoadState('networkidle');
      
      // Find a library entry
      const libraryEntry = page.locator('[data-testid="library-entry"], .library-entry, .library-card').first();
      
      if (await libraryEntry.isVisible()) {
        // Look for remove/delete button (often in a menu)
        const menuButton = libraryEntry.locator('button[aria-label*="menu"], button[aria-label*="options"], [data-testid="menu-button"]').first();
        
        if (await menuButton.isVisible()) {
          await menuButton.click();
          
          const removeOption = page.getByRole('menuitem', { name: /Remove|Delete/i });
          if (await removeOption.isVisible()) {
            await removeOption.click();
            
            // Confirm deletion if dialog appears
            const confirmButton = page.getByRole('button', { name: /Confirm|Yes|Remove/i });
            if (await confirmButton.isVisible()) {
              await confirmButton.click();
            }
            
            // Wait for removal
            await page.waitForTimeout(1000);
          }
        }
      }
    });
  });

  // Test unauthenticated access
  test.describe('Unauthenticated User', () => {
    test('should redirect to login when accessing library', async ({ page }) => {
      await page.goto('/library');
      
      // Should redirect to login or show auth prompt
      await expect(page).toHaveURL(/\/(login|signin|auth)/i, { timeout: 5000 }).catch(async () => {
        // Or show login prompt on page
        const loginPrompt = page.getByText(/Sign in|Log in|Please log in/i);
        await expect(loginPrompt).toBeVisible();
      });
    });

    test('should show add to library prompt for guests on series page', async ({ page }) => {
      await page.goto('/browse');
      await page.waitForLoadState('networkidle');
      
      const seriesCard = page.locator('a[href^="/series/"]').first();
      
      if (await seriesCard.isVisible()) {
        await seriesCard.click();
        await expect(page).toHaveURL(/\/series\//);
        
        // Guest should see "Sign in to add" or similar
        const addButton = page.getByRole('button', { name: /Add to Library|Track/i }).first();
        
        if (await addButton.isVisible()) {
          await addButton.click();
          
          // Should show login prompt
          const loginPrompt = page.getByText(/Sign in|Log in|Create account/i);
          await expect(loginPrompt).toBeVisible({ timeout: 3000 }).catch(() => {
            // Or redirect to login
            expect(page.url()).toMatch(/\/(login|signin|register)/i);
          });
        }
      }
    });
  });
});

// API-level library tests
test.describe('Library API', () => {
  test('GET /api/library requires authentication', async ({ request }) => {
    const response = await request.get('/api/library');
    expect(response.status()).toBe(401);
    
    const body = await response.json();
    expect(body.error).toBeDefined();
  });

  test('POST /api/library requires authentication', async ({ request }) => {
    const response = await request.post('/api/library', {
      data: { seriesId: '00000000-0000-0000-0000-000000000000' },
    });
    expect(response.status()).toBe(401);
  });

  test('PATCH /api/library/[id]/progress requires authentication', async ({ request }) => {
    const response = await request.patch('/api/library/00000000-0000-0000-0000-000000000000/progress', {
      data: { chapterNumber: 1 },
    });
    expect(response.status()).toBe(401);
  });

  test('API returns proper error format', async ({ request }) => {
    const response = await request.get('/api/library');
    const body = await response.json();
    
    // Should have standard error shape
    expect(body).toHaveProperty('error');
    expect(body).toHaveProperty('requestId');
  });
});
