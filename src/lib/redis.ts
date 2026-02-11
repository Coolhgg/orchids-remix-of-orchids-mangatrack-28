import 'dotenv/config';
import Redis, { RedisOptions } from 'ioredis';
import { logger } from '@/lib/logger';

const environment = process.env.NODE_ENV || 'development';
export const REDIS_KEY_PREFIX = `mangatrack:${environment}:`;

/**
 * Check if we're in Next.js build phase - used to suppress logging during builds
 */
function isBuildPhase(): boolean {
  return process.env.NEXT_PHASE === 'phase-production-build';
}

/**
 * Determines if Sentinel mode is enabled based on environment variables.
 * Sentinel is ONLY enabled when REDIS_SENTINEL_HOSTS is set.
 */
const isSentinelMode = !!process.env.REDIS_SENTINEL_HOSTS;

/**
 * Parse Sentinel hosts from env var.
 * Format: "host1:port1,host2:port2,host3:port3"
 */
function parseSentinelHosts(): Array<{ host: string; port: number }> {
  const hostsStr = process.env.REDIS_SENTINEL_HOSTS || '';
  if (!hostsStr) return [];
  
  return hostsStr.split(',').map(hostPort => {
    const [host, port] = hostPort.trim().split(':');
    return { host, port: parseInt(port, 10) || 26379 };
  });
}

/**
 * Build Redis connection options based on mode (single-node vs Sentinel).
 * @param url Optional explicit Redis URL. If not provided, defaults based on environment.
 */
export function buildRedisOptions(url?: string): RedisOptions {
  const baseOptions: RedisOptions = {
    maxRetriesPerRequest: null, // REQUIRED for BullMQ
    enableOfflineQueue: true,   // Allow queueing commands while connecting
    connectTimeout: isSentinelMode ? 15000 : 5000, // M4 FIX: Longer timeout for Sentinel failover
    retryStrategy: (times) => {
      if (times > 3) return null; // Stop retrying after 3 attempts to save connections
      return Math.min(times * 500, 2000);
    },
    reconnectOnError: (err) => {
      const targetErrors = ['READONLY', 'ECONNRESET', 'ETIMEDOUT'];
      return targetErrors.some(e => err.message.includes(e));
    },
  };

  if (isSentinelMode && !url) {
    // Sentinel mode configuration (only if no explicit URL is provided)
    const sentinels = parseSentinelHosts();
    const masterName = process.env.REDIS_SENTINEL_MASTER_NAME || 'mymaster';
    const sentinelPassword = process.env.REDIS_SENTINEL_PASSWORD || undefined;
    const redisPassword = process.env.REDIS_PASSWORD || undefined;

    // Only log if not in build phase
    if (!isBuildPhase()) {
      logger.info(`[Redis] Sentinel mode enabled with ${sentinels.length} sentinels, master: ${masterName}`);
    }

    return {
      ...baseOptions,
      sentinels,
      name: masterName,
      sentinelPassword,
      password: redisPassword,
      enableReadyCheck: true,
      sentinelRetryStrategy: (times) => {
        if (times > 5) return null;
        return Math.min(times * 1000, 5000);
      },
      failoverDetector: true,
    };
  }

  // Single-node mode
  const redisUrl = url || process.env.REDIS_URL || 'redis://localhost:6379';
  const parsedUrl = new URL(redisUrl);

  return {
    ...baseOptions,
    host: parsedUrl.hostname,
    port: parseInt(parsedUrl.port) || 6379,
    password: parsedUrl.password || undefined,
    username: parsedUrl.username || undefined,
  };
}

/**
 * Singleton pattern for Next.js hot reload protection
 */
const globalForRedis = globalThis as unknown as { 
  redisApi: Redis | undefined;
  redisWorker: Redis | undefined;
  redisTargetsLogged: boolean | undefined;
};

/**
 * Masks Redis URL for safe logging.
 * Format: redis://:***@host:port/db
 */
function maskRedisUrl(url: string | undefined): string {
  if (!url) return 'undefined';
  try {
    const parsed = new URL(url);
    const maskedAuth = (parsed.password || parsed.username) ? ':***' : '';
    return `${parsed.protocol}//${maskedAuth}${parsed.host}${parsed.pathname}`;
  } catch {
    return 'invalid-url';
  }
}

// Redis URLs - evaluated at module load but no logging
const apiRedisUrl = process.env.REDIS_API_URL || process.env.REDIS_URL;
const workerRedisUrl = process.env.REDIS_WORKER_URL || process.env.REDIS_URL;

/**
 * Log Redis targets only once, and never during build phase.
 * Uses globalThis to persist across module reloads in dev.
 */
function logRedisTargetsOnce() {
  // Skip during build phase entirely
  if (isBuildPhase()) return;
  
  // Use globalThis to ensure we only log once even with HMR
  if (globalForRedis.redisTargetsLogged) return;
  globalForRedis.redisTargetsLogged = true;
  
  logger.info(`[Redis] API Client Target: ${maskRedisUrl(apiRedisUrl)}`);
  logger.info(`[Redis] Worker Client Target: ${maskRedisUrl(workerRedisUrl)}`);
}

/**
 * Creates a configured Redis client.
 */
function createRedisClient(options: RedisOptions, name: string): Redis {
  // Log Redis targets on first actual client creation (not during build)
  logRedisTargetsOnce();
  
  const client = new Redis({
    ...options,
    lazyConnect: true,
  });

  // Skip verbose logging during build phase
  if (isBuildPhase()) {
    return client;
  }

  const clientInfo = options.host ? `${options.host}:${options.port}` : 'Sentinel';
  logger.info(`[Redis:${name}] Initializing client for ${clientInfo}`);

  client.on('error', (err) => {
    logger.error(`[Redis:${name}] Error: ${err.message}`);
  });

  client.on('connect', () => logger.info(`[Redis:${name}] Connection established`));
  client.on('close', () => logger.info(`[Redis:${name}] Connection closed`));
  client.on('ready', () => logger.info(`[Redis:${name}] Ready (Commands enabled)`));
  
  client.on('reconnecting', (delay: number) => {
    logger.warn(`[Redis:${name}] Reconnecting in ${delay}ms...`);
  });

  if (isSentinelMode && !options.host) {
    client.on('+switch-master', () => {
      logger.info(`[Redis:${name} Sentinel] Master switch detected - reconnecting to new master`);
    });
  }

  return client;
}

/**
 * P1-6 FIX: Thread-safe lazy Redis client with mutex to prevent race conditions
 * Creates a proxy for a Redis client to delay its initialization until it's actually used.
 */
function createLazyRedisClient(name: string, factory: () => Redis): Redis {
  let instance: Redis | null = null;
  let initializationLock: Promise<Redis> | null = null;
  
  const ensureInstance = async (): Promise<Redis> => {
    // Fast path: instance already created
    if (instance) return instance;
    
    // Acquire lock for initialization (prevents race condition)
    if (!initializationLock) {
      initializationLock = (async () => {
        // Double-check after acquiring lock
        if (!instance) {
          instance = factory();
        }
        return instance;
      })();
    }
    
    return initializationLock;
  };
  
  // Synchronous instance creation for proxy access
  const getOrCreateInstance = (): Redis => {
    if (!instance) {
      instance = factory();
    }
    return instance;
  };
  
  return new Proxy({} as Redis, {
    get(target, prop, receiver) {
      const inst = getOrCreateInstance();
      const value = Reflect.get(inst, prop, receiver);
      
      if (typeof value === 'function') {
        return (...args: any[]) => {
          const start = Date.now();
          const result = value.apply(inst, args);
          
          // Skip slow operation logging during build
          if (isBuildPhase()) {
            return result;
          }
          
          if (result instanceof Promise) {
            return result.finally(() => {
              const duration = Date.now() - start;
              if (duration > 50) {
                logger.warn(`[Redis:${name}] SLOW OPERATION: ${String(prop)} took ${duration}ms`);
              }
            });
          }
          
          const duration = Date.now() - start;
          if (duration > 50) {
            logger.warn(`[Redis:${name}] SLOW OPERATION: ${String(prop)} took ${duration}ms`);
          }
          return result;
        };
      }
      
      return value;
    }
  });
}

// REDIS A: API + caching (Uses API Redis instance)
export const redisApi = createLazyRedisClient('API', () => {
  if (globalForRedis.redisApi) return globalForRedis.redisApi;
  
  // OPTIMIZATION: If API and Worker URLs are the same, share the instance
  if (apiRedisUrl === workerRedisUrl && globalForRedis.redisWorker) {
    if (!isBuildPhase()) {
      logger.info('[Redis:API] Sharing instance with Worker client');
    }
    return globalForRedis.redisWorker;
  }

  const client = createRedisClient(
    { 
      ...buildRedisOptions(apiRedisUrl),
      enableReadyCheck: true 
    },
    'API'
  );
  if (process.env.NODE_ENV !== 'production') {
    globalForRedis.redisApi = client;
  }
  return client;
});

// REDIS B: Workers + BullMQ queues (Uses Worker Redis instance)
export const redisWorker = createLazyRedisClient('Worker', () => {
  if (globalForRedis.redisWorker) return globalForRedis.redisWorker;

  // OPTIMIZATION: If API and Worker URLs are the same, share the instance
  if (workerRedisUrl === apiRedisUrl && globalForRedis.redisApi) {
    if (!isBuildPhase()) {
      logger.info('[Redis:Worker] Sharing instance with API client');
    }
    return globalForRedis.redisApi;
  }

  const client = createRedisClient(
    { 
      ...buildRedisOptions(workerRedisUrl),
      maxRetriesPerRequest: null, // REQUIRED for BullMQ
      enableReadyCheck: false // Faster connection for workers
    },
    'Worker'
  );
  if (process.env.NODE_ENV !== 'production') {
    globalForRedis.redisWorker = client;
  }
  return client;
});

// REMOVED schedulerRedis to save connections. Use redisWorker instead.
export const schedulerRedis = redisWorker;

// Compatibility aliases
export const redis = redisApi;
export const redisApiClient = redisApi;
export const redisWorkerClient = redisWorker;

/**
 * Connection options for BullMQ (uses Worker Redis).
 */
export const redisConnection: RedisOptions = {
  ...buildRedisOptions(workerRedisUrl),
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
};

/**
 * Audit Redis connection usage and health.
 */
export async function getConnectionStats() {
  try {
    const info = await redisWorker.info('clients');
    const connectedClients = info.split('\n')
      .find(line => line.startsWith('connected_clients:'))
      ?.split(':')[1].trim();
    
    return {
      connected_clients: parseInt(connectedClients || '0', 10),
      process_pid: process.pid,
      api_status: redisApi.status,
      worker_status: redisWorker.status,
    };
  } catch (err: unknown) {
    logger.error('[Redis:Stats] Failed to retrieve connection stats:', err);
    return null;
  }
}

/**
 * Check if Redis is currently connected and responsive.
 */
export function isRedisAvailable(client: Redis = redisApi): boolean {
  return client.status === 'ready';
}

/**
 * Alias for isRedisAvailable - checks if Redis API client is connected.
 */
export function isRedisConnected(): boolean {
  return redisApi.status === 'ready';
}

/**
 * Wait for Redis to be ready (with timeout).
 * Supports both (client, timeout) and (timeout) signatures for robustness.
 */
export async function waitForRedis(clientOrTimeout: any = redisApi, timeoutMs?: number): Promise<boolean> {
  let client: Redis;
  let timeout: number;

  // Handle (timeout) signature
  if (typeof clientOrTimeout === 'number') {
    client = redisApi;
    timeout = clientOrTimeout;
  } else {
    // Handle (client, timeout) signature
    client = clientOrTimeout || redisApi;
    timeout = timeoutMs ?? 3000;
  }

  // Final safety check to ensure we have a valid client with status/once
  if (!client || typeof client.once !== 'function' || typeof client.on !== 'function' || typeof client.off !== 'function') {
    return client?.status === 'ready';
  }

  if (client.status === 'ready') return true;
  if (client.status === 'end' || client.status === 'close') return false;
  
  // If lazyConnect is on and status is wait, trigger connection
  if (client.status === 'wait') {
    client.connect().catch((err) => {
      if (!isBuildPhase()) {
        logger.warn('[Redis] Lazy connect failed:', err instanceof Error ? err.message : err);
      }
    });
  }
  
    return new Promise((resolve) => {
      let resolved = false;

      const cleanup = () => {
        if (typeof client.off === 'function') {
          client.off('ready', onReady);
          client.off('error', onError);
        }
      };

      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve(false);
      }, timeout);

      const onReady = () => { 
        if (resolved) return;
        resolved = true;
        clearTimeout(timer); 
        cleanup();
        resolve(true); 
      };
      
      const onError = () => { 
        if (resolved) return;
        resolved = true;
        clearTimeout(timer); 
        cleanup();
        resolve(false); 
      };

      try {
        client.once('ready', onReady);
        client.once('error', onError);
      } catch (err: unknown) {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          cleanup();
          resolve(false);
        }
      }
    });
}

/**
 * Check if workers are online (status stored in API Redis).
 * 
 * FIX: Added retry logic and increased threshold from 15s to 45s
 * to prevent false negatives from transient Redis issues or GC pauses.
 * 
 * Workers send heartbeat every 15s, TTL is 30s, threshold is 45s (3x interval).
 */
export async function areWorkersOnline(retries = 2): Promise<boolean> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const redisReady = await waitForRedis(redisApi, 3000);
    if (!redisReady) {
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 500));
        continue;
      }
      return false;
    }
    
    try {
      const heartbeat = await redisApi.get(`${REDIS_KEY_PREFIX}workers:heartbeat`);
      if (!heartbeat) {
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, 500));
          continue;
        }
        return false;
      }
      
      const data = JSON.parse(heartbeat);
      const age = Date.now() - data.timestamp;
      
      // FIX: Increased threshold from 15s to 45s (3x the heartbeat interval)
      // This provides a buffer for:
      // - GC pauses in the worker process
      // - Redis latency spikes
      // - Network hiccups
      if (age < 45000) {
        return true;
      }
      
      // Heartbeat is stale, retry if we have attempts left
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 500));
        continue;
      }
      
      if (!isBuildPhase()) {
        logger.warn(`[Redis] Worker heartbeat is stale (${Math.round(age/1000)}s old)`);
      }
      return false;
    } catch (err: unknown) {
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 500));
        continue;
      }
      if (!isBuildPhase()) {
        logger.error('[Redis] Error checking worker heartbeat:', err);
      }
      return false;
    }
  }
  return false;
}

/**
 * Set worker heartbeat (stored in API Redis).
 * 
 * FIX: Increased TTL from 10s to 30s to prevent false offline detection.
 * Combined with 15s heartbeat interval, this provides 2x buffer.
 */
export async function setWorkerHeartbeat(healthData?: any): Promise<void> {
  try {
    const payload = {
      timestamp: Date.now(),
      health: healthData || { status: 'healthy' },
      pid: process.pid,
    };
    // FIX: Increased TTL from 10s to 30s (2x the heartbeat interval)
    await redisApi.set(`${REDIS_KEY_PREFIX}workers:heartbeat`, JSON.stringify(payload), 'EX', 30);
  } catch (err: unknown) {
    logger.error('[Redis] Error setting worker heartbeat:', err);
    throw err;
  }
}

/**
 * Distributed lock using Worker Redis.
 */
export async function withLock<T>(
  lockKey: string,
  ttlMs: number,
  fn: () => Promise<T>
): Promise<T> {
  const fullLockKey = `${REDIS_KEY_PREFIX}lock:${lockKey}`;
  const lockValue = Math.random().toString(36).slice(2);
  if (!redisWorker || typeof redisWorker.set !== 'function') {
    throw new Error(`Redis worker client not ready for lock: ${lockKey}`);
  }
  const acquired = await redisWorker.set(fullLockKey, lockValue, 'PX', ttlMs, 'NX');
  
  if (!acquired) throw new Error(`Failed to acquire lock: ${lockKey}`);
  
  try {
    return await fn();
  } finally {
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    await redisWorker.eval(script, 1, fullLockKey, lockValue);
  }
}

/**
 * Safely disconnects from both Redis clients.
 */
export async function disconnectRedis(): Promise<void> {
  const disconnect = async (client: Redis, name: string) => {
    if (client.status === 'end') return;
    try {
      await client.quit();
      if (!isBuildPhase()) {
        logger.info(`[Redis:${name}] Disconnected`);
      }
    } catch (err: unknown) {
      client.disconnect();
    }
  };

  await Promise.all([
    disconnect(redisApi, 'API'),
    disconnect(redisWorker, 'Worker')
  ]);
}

export const redisMode = isSentinelMode ? 'sentinel' : 'single-node';
