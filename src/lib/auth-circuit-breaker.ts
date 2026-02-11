/**
 * Auth Circuit Breaker
 * 
 * Implements circuit breaker pattern for Supabase auth calls to prevent
 * cascading failures when the auth service is degraded.
 * 
 * States:
 * - CLOSED: Normal operation, auth calls proceed
 * - OPEN: Auth is degraded, fail fast without calling Supabase
 * - HALF_OPEN: Testing if auth has recovered
 */

import { logger } from './logger';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerConfig {
  /** Number of consecutive failures to open circuit */
  failureThreshold: number;
  /** Time in ms to keep circuit open before testing */
  openDurationMs: number;
  /** Number of successes needed in half-open to close circuit */
  successThreshold: number;
  /** Time window in ms for counting failures */
  failureWindowMs: number;
}

export interface CircuitBreakerState {
  state: CircuitState;
  failureCount: number;
  successCount: number;
  lastFailureAt: number;
  lastSuccessAt: number;
  openedAt: number | null;
  halfOpenAt: number | null;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 10,
  openDurationMs: 30000, // 30 seconds (recover faster)
  successThreshold: 2,
  failureWindowMs: 60000, // 60 seconds (wider window to avoid flapping)
};

// Use global variable for circuit state to persist across HMR and potentially 
// survive between requests in the same serverless isolate.
const globalForCircuit = global as unknown as { 
  circuitState: CircuitBreakerState | undefined
  circuitConfig: CircuitBreakerConfig | undefined
}

const DEFAULT_STATE: CircuitBreakerState = {
  state: 'CLOSED',
  failureCount: 0,
  successCount: 0,
  lastFailureAt: 0,
  lastSuccessAt: 0,
  openedAt: null,
  halfOpenAt: null,
};

// Singleton state for auth circuit breaker
let circuitState: CircuitBreakerState = globalForCircuit.circuitState ?? { ...DEFAULT_STATE };
let config: CircuitBreakerConfig = globalForCircuit.circuitConfig ?? { ...DEFAULT_CONFIG };

// P3 #13 FIX: Persist in global for ALL environments so state survives
// across requests within the same serverless isolate (Vercel/Edge).
// Note: State still won't persist across different isolates, but this 
// maximizes effectiveness within a single long-lived process.
globalForCircuit.circuitState = circuitState;
globalForCircuit.circuitConfig = config;

/**
 * Configure the circuit breaker
 */
export function configureCircuitBreaker(newConfig: Partial<CircuitBreakerConfig>): void {
  config = { ...config, ...newConfig };
  globalForCircuit.circuitConfig = config;
}

/**
 * Get the current circuit state
 */
export function getCircuitState(): CircuitBreakerState {
  updateCircuitState();
  return { ...circuitState };
}

/**
 * Check if the circuit allows a request
 */
export function canMakeAuthRequest(): boolean {
  updateCircuitState();
  
  switch (circuitState.state) {
    case 'CLOSED':
      return true;
    case 'OPEN':
      return false;
    case 'HALF_OPEN':
      // Allow limited requests in half-open state to test recovery
      return true;
  }
}

/**
 * Record a successful auth call
 */
export function recordAuthSuccess(): void {
  const now = Date.now();
  circuitState.lastSuccessAt = now;
  circuitState.successCount++;
  
  // Reset failure count on success
  circuitState.failureCount = 0;
  
  if (circuitState.state === 'HALF_OPEN') {
    if (circuitState.successCount >= config.successThreshold) {
      // Enough successes to close the circuit
      circuitState.state = 'CLOSED';
      circuitState.openedAt = null;
      circuitState.halfOpenAt = null;
      circuitState.successCount = 0;
      logger.info('[AuthCircuitBreaker] Circuit CLOSED - auth service recovered');
    }
  }
}

/**
 * Record a failed auth call (timeout or error)
 */
export function recordAuthFailure(): void {
  const now = Date.now();
  
  // Reset failure count if outside the failure window
  if (circuitState.lastFailureAt > 0 && now - circuitState.lastFailureAt > config.failureWindowMs) {
    circuitState.failureCount = 0;
  }
  
  circuitState.lastFailureAt = now;
  
  circuitState.failureCount++;
  circuitState.successCount = 0; // Reset success count on failure
  
  if (circuitState.state === 'HALF_OPEN') {
    // Any failure in half-open reopens the circuit
    circuitState.state = 'OPEN';
    circuitState.openedAt = now;
    circuitState.halfOpenAt = null;
    logger.warn('[AuthCircuitBreaker] Circuit OPEN - auth failed during recovery test');
  } else if (circuitState.state === 'CLOSED') {
    if (circuitState.failureCount >= config.failureThreshold) {
      // Open the circuit after threshold failures
      circuitState.state = 'OPEN';
      circuitState.openedAt = now;
      logger.warn(`[AuthCircuitBreaker] Circuit OPEN - ${circuitState.failureCount} consecutive failures`);
    }
  }
}

/**
 * Update circuit state based on timers
 */
function updateCircuitState(): void {
  const now = Date.now();
  
  if (circuitState.state === 'OPEN' && circuitState.openedAt) {
    const elapsed = now - circuitState.openedAt;
    
    if (elapsed >= config.openDurationMs) {
      // Transition to half-open to test recovery
      circuitState.state = 'HALF_OPEN';
      circuitState.halfOpenAt = now;
      circuitState.successCount = 0;
      logger.info('[AuthCircuitBreaker] Circuit HALF_OPEN - testing auth recovery');
    }
  }
}

/**
 * Force reset the circuit (for testing/admin)
 */
export function resetCircuit(): void {
  circuitState = {
    state: 'CLOSED',
    failureCount: 0,
    successCount: 0,
    lastFailureAt: 0,
    lastSuccessAt: 0,
    openedAt: null,
    halfOpenAt: null,
  };
  logger.info('[AuthCircuitBreaker] Circuit manually reset to CLOSED');
}

/**
 * Get circuit breaker metrics for monitoring
 */
export function getCircuitMetrics(): {
  state: CircuitState;
  failureCount: number;
  timeSinceLastFailure: number;
  timeSinceOpened: number | null;
  isHealthy: boolean;
} {
  const now = Date.now();
  
  return {
    state: circuitState.state,
    failureCount: circuitState.failureCount,
    timeSinceLastFailure: circuitState.lastFailureAt ? now - circuitState.lastFailureAt : -1,
    timeSinceOpened: circuitState.openedAt ? now - circuitState.openedAt : null,
    isHealthy: circuitState.state === 'CLOSED',
  };
}

/**
 * Wrapper for auth calls with circuit breaker
 */
export async function withCircuitBreaker<T>(
  authFn: () => Promise<T>,
  fallback?: T
): Promise<{ result: T | null; circuitOpen: boolean; error?: Error }> {
  if (!canMakeAuthRequest()) {
    return {
      result: fallback ?? null,
      circuitOpen: true,
    };
  }
  
  try {
    const result = await authFn();
    recordAuthSuccess();
    return { result, circuitOpen: false };
  } catch (error: unknown) {
    recordAuthFailure();
    return {
      result: fallback ?? null,
      circuitOpen: circuitState.state === 'OPEN',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}
