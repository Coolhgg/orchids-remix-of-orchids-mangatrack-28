/**
 * Auth-Aware Fetch Utility
 * 
 * Provides automatic retry handling for auth-related errors,
 * graceful degradation when auth service is unavailable,
 * and consistent error handling across the app.
 */

import { logger } from './logger';

export interface AuthFetchOptions extends RequestInit {
  /** Number of retries on auth timeout (default: 1) */
  retries?: number;
  /** Delay between retries in ms (default: 500) */
  retryDelay?: number;
  /** Whether to throw on auth errors or return null (default: throw) */
  throwOnAuthError?: boolean;
}

export interface AuthFetchResult<T> {
  data: T | null;
  error: string | null;
  status: number;
  isAuthDegraded: boolean;
  shouldRetry: boolean;
}

/**
 * Check if the response indicates auth service is degraded
 */
function isAuthDegraded(response: Response): boolean {
  return response.headers.get('x-auth-degraded') !== null;
}

/**
 * Check if the error indicates we should retry
 */
function shouldRetryAuth(response: Response, body: unknown): boolean {
  // Check for auth timeout response
  if (response.status === 401 || response.status === 503) {
    const degradedHeader = response.headers.get('x-auth-degraded');
    if (degradedHeader === 'timeout' || degradedHeader === 'circuit_open') {
      return true;
    }
    // Check body for retry hint
    if (typeof body === 'object' && body !== null && 'retry' in body) {
      return (body as { retry?: boolean }).retry === true;
    }
  }
  return false;
}

/**
 * Wait for a specified delay
 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Auth-aware fetch with automatic retry on auth timeout
 * 
 * @example
 * ```ts
 * const result = await authFetch<LibraryEntry[]>('/api/library');
 * if (result.data) {
 *   // Handle data
 * } else if (result.isAuthDegraded) {
 *   // Show degraded mode UI
 * } else {
 *   // Handle error
 * }
 * ```
 */
export async function authFetch<T = unknown>(
  url: string,
  options: AuthFetchOptions = {}
): Promise<AuthFetchResult<T>> {
  const {
    retries = 1,
    retryDelay = 500,
    throwOnAuthError = false,
    ...fetchOptions
  } = options;

  let lastResponse: Response | null = null;
  let lastBody: unknown = null;
  let attempts = 0;

  while (attempts <= retries) {
    attempts++;
    
    try {
      const response = await fetch(url, fetchOptions);
      lastResponse = response;
      
      // Try to parse JSON body
      let body: unknown;
      const contentType = response.headers.get('content-type');
      if (contentType?.includes('application/json')) {
        try {
          body = await response.json();
          lastBody = body;
        } catch {
          body = null;
        }
      }
      
      // Success case
      if (response.ok) {
        return {
          data: body as T,
          error: null,
          status: response.status,
          isAuthDegraded: isAuthDegraded(response),
          shouldRetry: false,
        };
      }
      
      // Check if we should retry
      if (shouldRetryAuth(response, body) && attempts <= retries) {
        logger.info(`[authFetch] Auth timeout, retrying (attempt ${attempts}/${retries + 1})...`);
        await delay(retryDelay * attempts); // Exponential backoff
        continue;
      }
      
      // Auth error - return or throw
      if (response.status === 401) {
        if (throwOnAuthError) {
          throw new AuthError('Unauthorized', response.status, isAuthDegraded(response));
        }
        return {
          data: null,
          error: 'unauthorized',
          status: response.status,
          isAuthDegraded: isAuthDegraded(response),
          shouldRetry: shouldRetryAuth(response, body),
        };
      }
      
      // Service unavailable (circuit open)
      if (response.status === 503) {
        const retryAfter = response.headers.get('Retry-After');
        return {
          data: null,
          error: 'service_unavailable',
          status: response.status,
          isAuthDegraded: true,
          shouldRetry: true,
        };
      }
      
      // Other error
      const errorMessage = typeof body === 'object' && body !== null && 'error' in body
        ? String((body as { error: unknown }).error)
        : response.statusText || 'Request failed';
        
      return {
        data: null,
        error: errorMessage,
        status: response.status,
        isAuthDegraded: isAuthDegraded(response),
        shouldRetry: false,
      };
      
    } catch (error: unknown) {
      // Network error
      if (attempts <= retries) {
          logger.info(`[authFetch] Network error, retrying (attempt ${attempts}/${retries + 1})...`);
        await delay(retryDelay * attempts);
        continue;
      }
      
      return {
        data: null,
        error: error instanceof Error ? error.message : 'Network error',
        status: 0,
        isAuthDegraded: false,
        shouldRetry: true,
      };
    }
  }
  
  // Should not reach here, but return last state if we do
  return {
    data: null,
    error: 'Max retries exceeded',
    status: lastResponse?.status ?? 0,
    isAuthDegraded: lastResponse ? isAuthDegraded(lastResponse) : false,
    shouldRetry: false,
  };
}

/**
 * Custom error class for auth-related errors
 */
export class AuthError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly isDegraded: boolean
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/**
 * Hook-friendly wrapper that handles loading/error states
 * Returns a fetcher function that can be used with SWR or React Query
 */
export function createAuthFetcher<T = unknown>(baseOptions: AuthFetchOptions = {}) {
  return async (url: string): Promise<T> => {
    const result = await authFetch<T>(url, { ...baseOptions, throwOnAuthError: true });
    if (result.error) {
      throw new Error(result.error);
    }
    return result.data as T;
  };
}

/**
 * Check if the current session might be degraded
 * Useful for showing warning banners
 */
export async function checkAuthHealth(): Promise<{
  healthy: boolean;
  degraded: boolean;
  reason?: string;
}> {
  try {
    const response = await fetch('/api/health/auth', {
      method: 'HEAD',
      cache: 'no-store',
    });
    
    if (response.ok) {
      return { healthy: true, degraded: false };
    }
    
    const degradedHeader = response.headers.get('x-auth-degraded');
    if (degradedHeader) {
      return {
        healthy: false,
        degraded: true,
        reason: degradedHeader,
      };
    }
    
    return { healthy: false, degraded: false, reason: 'unknown' };
  } catch {
    return { healthy: false, degraded: true, reason: 'network_error' };
  }
}
