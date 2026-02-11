'use client';

import { useCallback, useRef } from 'react';

interface FetchOptions extends RequestInit {
  skipRetry?: boolean;
}

interface AuthRetryConfig {
  maxRetries?: number;
  retryDelay?: number;
  onAuthCircuitOpen?: () => void;
  onAuthTimeout?: () => void;
}

const DEFAULT_CONFIG: Required<AuthRetryConfig> = {
  maxRetries: 3,
  retryDelay: 500,
  onAuthCircuitOpen: () => {},
  onAuthTimeout: () => {},
};

/**
 * Hook for handling auth-related fetch retries
 * 
 * Automatically retries requests when:
 * - Server returns 401 with x-auth-degraded: timeout header
 * - Server returns 503 with x-auth-degraded: circuit_open header
 */
export function useAuthRetry(config: AuthRetryConfig = {}) {
  const { maxRetries, retryDelay, onAuthCircuitOpen, onAuthTimeout } = {
    ...DEFAULT_CONFIG,
    ...config,
  };

  const retryCountRef = useRef(0);

  const fetchWithRetry = useCallback(
    async <T = unknown>(
      url: string,
      options: FetchOptions = {}
    ): Promise<{ data: T | null; error: Error | null; authDegraded: boolean }> => {
      const { skipRetry = false, ...fetchOptions } = options;
      let lastError: Error | null = null;
      let authDegraded = false;

      for (let attempt = 0; attempt <= (skipRetry ? 0 : maxRetries); attempt++) {
        try {
          const response = await fetch(url, fetchOptions);
          const authDegradedHeader = response.headers.get('x-auth-degraded');

          if (authDegradedHeader === 'circuit_open') {
            authDegraded = true;
            onAuthCircuitOpen();
            
            // Don't retry if circuit is open - it won't help
            const retryAfter = response.headers.get('retry-after');
            return {
              data: null,
              error: new Error(`Auth service unavailable. Retry after ${retryAfter || 60}s`),
              authDegraded: true,
            };
          }

            if (authDegradedHeader === 'timeout' && response.status === 401) {
              authDegraded = true;
              onAuthTimeout();

              // Retry after exponential backoff if we have retries left
              if (attempt < maxRetries && !skipRetry) {
                retryCountRef.current = attempt + 1;
                const backoffDelay = retryDelay * Math.pow(2, attempt);
                await new Promise((resolve) => setTimeout(resolve, backoffDelay));
                continue;
              }
            }

          if (!response.ok) {
            const errorData = await response.json().catch(() => ({ error: 'Request failed' }));
            throw new Error(errorData.error || `HTTP ${response.status}`);
          }

          const data = await response.json();
          retryCountRef.current = 0;
          return { data, error: null, authDegraded };
        } catch (error: unknown) {
          lastError = error instanceof Error ? error : new Error(String(error));
          
            // Only retry on network errors if we have retries left
            if (attempt < maxRetries && !skipRetry) {
              const backoffDelay = retryDelay * Math.pow(2, attempt);
              await new Promise((resolve) => setTimeout(resolve, backoffDelay));
              continue;
            }
        }
      }

      return { data: null, error: lastError, authDegraded };
    },
    [maxRetries, retryDelay, onAuthCircuitOpen, onAuthTimeout]
  );

  const resetRetryCount = useCallback(() => {
    retryCountRef.current = 0;
  }, []);

  return {
    fetchWithRetry,
    resetRetryCount,
    retryCount: retryCountRef.current,
  };
}

/**
 * Utility function for checking if a response indicates auth degradation
 */
export function isAuthDegraded(response: Response): {
  degraded: boolean;
  reason: 'timeout' | 'circuit_open' | null;
  retryAfter: number | null;
} {
  const header = response.headers.get('x-auth-degraded');
  
  if (!header) {
    return { degraded: false, reason: null, retryAfter: null };
  }

  const retryAfterHeader = response.headers.get('retry-after');
  const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) : null;

  return {
    degraded: true,
    reason: header as 'timeout' | 'circuit_open',
    retryAfter,
  };
}

/**
 * Simple wrapper for fetch that handles auth degradation
 */
export async function authAwareFetch(
  url: string,
  options?: RequestInit
): Promise<Response> {
  const response = await fetch(url, options);
  
  const { degraded, reason } = isAuthDegraded(response);
  
  if (degraded && reason === 'circuit_open') {
    // Log for monitoring but don't throw - let caller handle
    console.warn('[Auth] Circuit breaker open - auth service unavailable');
  }
  
  if (degraded && reason === 'timeout') {
    console.warn('[Auth] Auth service timeout - may need retry');
  }

  return response;
}
