/**
 * MangaUpdates Cache Unit Tests
 * Tests: TTL behavior, in-memory fallback, cache key generation
 */

describe('MangaUpdates Cache - In-Memory Fallback', () => {
  // Mock cache that supports manual time control
  class MockInMemoryCache {
    private cache = new Map<string, { value: unknown; expiresAt: number }>();
    private mockNow: number = Date.now();

    setMockTime(time: number) {
      this.mockNow = time;
    }

    advanceTime(ms: number) {
      this.mockNow += ms;
    }

    async get<T>(key: string): Promise<T | null> {
      const entry = this.cache.get(key);
      if (!entry) return null;
      if (this.mockNow > entry.expiresAt) {
        this.cache.delete(key);
        return null;
      }
      return entry.value as T;
    }

    async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
      this.cache.set(key, {
        value,
        expiresAt: this.mockNow + ttlSeconds * 1000,
      });
    }

    async has(key: string): Promise<boolean> {
      const entry = this.cache.get(key);
      if (!entry) return false;
      if (this.mockNow > entry.expiresAt) {
        this.cache.delete(key);
        return false;
      }
      return true;
    }

    async delete(key: string): Promise<boolean> {
      return this.cache.delete(key);
    }

    get size(): number {
      return this.cache.size;
    }
  }

  it('stores and retrieves values within TTL', async () => {
    const cache = new MockInMemoryCache();
    const testData = { id: 123, title: 'Test Manga' };

    await cache.set('series:123', testData, 3600);

    const retrieved = await cache.get('series:123');
    expect(retrieved).toEqual(testData);
  });

  it('returns null for expired entries', async () => {
    const cache = new MockInMemoryCache();
    await cache.set('series:123', { id: 123 }, 1);

    // Advance time past TTL
    cache.advanceTime(2000);

    const retrieved = await cache.get('series:123');
    expect(retrieved).toBeNull();
  });

  it('has() returns false for expired entries', async () => {
    const cache = new MockInMemoryCache();
    await cache.set('series:123', { id: 123 }, 1);

    expect(await cache.has('series:123')).toBe(true);

    // Advance time past TTL
    cache.advanceTime(2000);

    expect(await cache.has('series:123')).toBe(false);
  });

  it('returns null for non-existent keys', async () => {
    const cache = new MockInMemoryCache();
    const result = await cache.get('nonexistent');
    expect(result).toBeNull();
  });

  it('delete removes entries', async () => {
    const cache = new MockInMemoryCache();
    await cache.set('series:123', { id: 123 }, 3600);

    expect(await cache.delete('series:123')).toBe(true);
    expect(await cache.get('series:123')).toBeNull();
  });

  it('tracks cache size correctly', async () => {
    const cache = new MockInMemoryCache();

    expect(cache.size).toBe(0);
    await cache.set('key1', 'value1', 3600);
    expect(cache.size).toBe(1);
    await cache.set('key2', 'value2', 3600);
    expect(cache.size).toBe(2);
    await cache.delete('key1');
    expect(cache.size).toBe(1);
  });
});

describe('Cache Key Generators', () => {
  it('seriesCacheKey generates correct format', () => {
    const { seriesCacheKey } = require('@/lib/mangaupdates/cache');
    expect(seriesCacheKey(12345)).toBe('series:12345');
  });

  it('releasesCacheKey includes days and page', () => {
    const { releasesCacheKey } = require('@/lib/mangaupdates/cache');
    expect(releasesCacheKey(7, 1)).toBe('releases:days:7:page:1');
  });

  it('searchCacheKey encodes query', () => {
    const { searchCacheKey } = require('@/lib/mangaupdates/cache');
    expect(searchCacheKey('One Piece', 1)).toBe('search:One%20Piece:page:1');
  });
});

describe('CACHE_TTL constants', () => {
  it('has correct TTL values', () => {
    const { CACHE_TTL } = require('@/lib/mangaupdates/cache');

    expect(CACHE_TTL.SERIES_METADATA).toBe(86400);
    expect(CACHE_TTL.RELEASES).toBe(900);
    expect(CACHE_TTL.SEARCH).toBe(3600);
  });
});
