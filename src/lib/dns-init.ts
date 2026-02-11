import * as dns from 'node:dns';
import { logger } from './logger';

/**
 * Check if we're in Next.js build phase - used to suppress initialization during builds
 */
function isBuildPhase(): boolean {
  return process.env.NEXT_PHASE === 'phase-production-build';
}

// PRE-CACHE IPs for critical MangaDex domains to bypass DNS failures entirely
// Using multiple IPs for redundancy
const HOST_CACHE: Record<string, string[]> = {
    'api.mangadex.org': ['172.67.161.164', '104.21.43.14', '172.67.202.162'],
    'uploads.mangadex.org': ['172.67.182.204', '104.21.67.52', '104.21.60.101'],
    'cdn.mangadex.org': ['172.67.161.164', '104.21.43.14', '104.21.72.227']
};

/**
 * Initialize DNS settings to use public DNS servers as fallback.
 * This helps resolve domains like api.mangadex.org which might be blocked
 * or failing via the default system DNS in some environments.
 * 
 * Note: This function is a no-op during Next.js build phase to prevent
 * excessive logging and unnecessary network I/O during static generation.
 */
export function initDNS() {
    // Skip entirely during build phase - DNS patching is only needed at runtime
    if (isBuildPhase()) {
        return;
    }
    
    // Prevent multiple patching which leads to stack overflow or memory leaks
    if ((global as any)._dnsPatched) {
        return;
    }
    
    // Set flag immediately to prevent concurrent initialization
    (global as any)._dnsPatched = true;

    try {
        // Only set servers if we are in a Node.js environment
        if (typeof window === 'undefined' && dns && typeof dns.setServers === 'function') {
            const servers = [
                '8.8.8.8', 
                '1.1.1.1', 
                '8.8.4.4', 
                '1.0.0.1', 
                '9.9.9.9',
                '208.67.222.222'
            ];
            
            try {
                dns.setServers(servers);
                // Only log once at startup, not during every module load
                if (process.env.NODE_ENV !== 'production') {
                    logger.info(`[DNS] Initialized fallback DNS servers`);
                }
            } catch (e: unknown) {
                // Silent fail - system DNS will be used
            }

            // Patch dns.lookup to use our cache if resolution fails
            const originalLookup = dns.lookup;
            
            type LookupCallback = (err: NodeJS.ErrnoException | null, address: string, family: number) => void;
            
            const patchedLookup = (hostname: string, options: unknown, callback?: LookupCallback) => {
                let cb = callback;
                let opts = options;
                if (typeof options === 'function') {
                    cb = options as LookupCallback;
                    opts = {};
                }

                originalLookup(hostname, opts as object, (err, address, family) => {
                    if (err && HOST_CACHE[hostname]) {
                        const ips = HOST_CACHE[hostname];
                        const fallbackIp = ips[Math.floor(Math.random() * ips.length)];
                        // Log fallback usage only in development for debugging
                        if (process.env.NODE_ENV !== 'production') {
                            logger.warn(`[DNS] ${hostname} resolution failed (${err.code}). Using fallback: ${fallbackIp}`);
                        }
                        return cb?.(null, fallbackIp, 4);
                    }
                    cb?.(err, address, family);
                });
            };

            // @ts-expect-error - dns.lookup is not normally assignable but we need to patch it
            dns.lookup = patchedLookup as any;

            // Skip pre-resolution in production - let it happen on demand
            if (process.env.NODE_ENV !== 'production') {
                // Pre-resolve important hostnames to warm up the cache
                const hosts = Object.keys(HOST_CACHE);
                hosts.forEach(host => {
                    dns.lookup(host, (err, address) => {
                        if (!err) {
                            logger.info(`[DNS] Pre-resolved ${host} to ${address}`);
                        }
                    });
                });
            }
        }
    } catch (error: unknown) {
        // Silent fail during initialization - DNS will work with system defaults
        if (process.env.NODE_ENV !== 'production') {
            logger.warn('[DNS] Failed to initialize DNS:', error);
        }
    }
}
