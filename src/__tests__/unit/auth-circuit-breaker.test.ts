/**
 * Tests for Auth Circuit Breaker
 * Validates the circuit breaker state machine, failure window reset,
 * and the critical bug fix where lastFailureAt was set before the window check.
 */
import {
  recordAuthFailure,
  recordAuthSuccess,
  resetCircuit,
  getCircuitState,
  canMakeAuthRequest,
  configureCircuitBreaker,
  withCircuitBreaker,
} from '../../lib/auth-circuit-breaker';

// Mock the logger to avoid side effects
jest.mock('../../lib/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe('Auth Circuit Breaker', () => {
  beforeEach(() => {
    resetCircuit();
    configureCircuitBreaker({
      failureThreshold: 5,
      openDurationMs: 60000,
      successThreshold: 2,
      failureWindowMs: 30000,
    });
  });

  describe('initial state', () => {
    it('starts CLOSED and allows requests', () => {
      const state = getCircuitState();
      expect(state.state).toBe('CLOSED');
      expect(state.failureCount).toBe(0);
      expect(canMakeAuthRequest()).toBe(true);
    });
  });

  describe('failure counting', () => {
    it('increments failure count on each failure', () => {
      recordAuthFailure();
      recordAuthFailure();
      recordAuthFailure();
      expect(getCircuitState().failureCount).toBe(3);
    });

    it('opens circuit after reaching failure threshold', () => {
      for (let i = 0; i < 5; i++) {
        recordAuthFailure();
      }
      expect(getCircuitState().state).toBe('OPEN');
      expect(canMakeAuthRequest()).toBe(false);
    });

    it('does not open circuit below threshold', () => {
      for (let i = 0; i < 4; i++) {
        recordAuthFailure();
      }
      expect(getCircuitState().state).toBe('CLOSED');
      expect(canMakeAuthRequest()).toBe(true);
    });
  });

  describe('failure window reset (P0 bug fix)', () => {
    it('resets failure count when failures are outside the window', () => {
      // Record 4 failures (just below threshold)
      for (let i = 0; i < 4; i++) {
        recordAuthFailure();
      }
      expect(getCircuitState().failureCount).toBe(4);

      // Simulate time passing beyond the failure window (30s)
      const state = getCircuitState();
      // Directly manipulate lastFailureAt to simulate passage of time
      // We need to access the internal state, so we use a workaround:
      // Record the failures, then advance time by mocking Date.now
      const realDateNow = Date.now;
      const baseTime = realDateNow.call(Date);

      // Mock Date.now to return time beyond the failure window
      Date.now = jest.fn(() => baseTime + 31000); // 31 seconds later

      // The next failure should reset the count (was 4, reset to 0, then +1 = 1)
      recordAuthFailure();
      const newState = getCircuitState();
      expect(newState.failureCount).toBe(1); // Reset to 0, then incremented to 1
      expect(newState.state).toBe('CLOSED'); // Should NOT be open

      Date.now = realDateNow;
    });

    it('does NOT reset failure count when failures are within the window', () => {
      const realDateNow = Date.now;
      const baseTime = realDateNow.call(Date);

      // Record failures in quick succession (within window)
      Date.now = jest.fn(() => baseTime);
      recordAuthFailure();
      recordAuthFailure();
      recordAuthFailure();

      // 10 seconds later (still within 30s window)
      Date.now = jest.fn(() => baseTime + 10000);
      recordAuthFailure();

      expect(getCircuitState().failureCount).toBe(4);
      expect(getCircuitState().state).toBe('CLOSED');

      Date.now = realDateNow;
    });

    it('prevents circuit from opening on spread-out failures (the original bug scenario)', () => {
      // This is the exact scenario the bug caused:
      // 1 failure per minute over 5 minutes should NOT open the circuit
      // because each failure is outside the 30s window
      const realDateNow = Date.now;
      const baseTime = realDateNow.call(Date);

      for (let i = 0; i < 10; i++) {
        // Each failure 60 seconds apart (well outside 30s window)
        Date.now = jest.fn(() => baseTime + i * 60000);
        recordAuthFailure();
      }

      // Failure count should be 1 (reset each time), circuit should stay CLOSED
      expect(getCircuitState().failureCount).toBe(1);
      expect(getCircuitState().state).toBe('CLOSED');
      expect(canMakeAuthRequest()).toBe(true);

      Date.now = realDateNow;
    });

    it('opens circuit only when failures cluster within the window', () => {
      const realDateNow = Date.now;
      const baseTime = realDateNow.call(Date);

      // 3 spread-out failures (reset each time)
      Date.now = jest.fn(() => baseTime);
      recordAuthFailure();
      Date.now = jest.fn(() => baseTime + 60000);
      recordAuthFailure();
      Date.now = jest.fn(() => baseTime + 120000);
      recordAuthFailure();
      expect(getCircuitState().failureCount).toBe(1);

      // Now 5 rapid failures within the window
      for (let i = 0; i < 5; i++) {
        Date.now = jest.fn(() => baseTime + 120000 + i * 1000);
        recordAuthFailure();
      }

      // Should be OPEN now (5 rapid failures after the reset)
      // Count: reset to 0 on first (outside window), then 1,2,3,4,5
      expect(getCircuitState().state).toBe('OPEN');

      Date.now = realDateNow;
    });
  });

  describe('success resets failures', () => {
    it('resets failure count on success', () => {
      recordAuthFailure();
      recordAuthFailure();
      recordAuthFailure();
      expect(getCircuitState().failureCount).toBe(3);

      recordAuthSuccess();
      expect(getCircuitState().failureCount).toBe(0);
    });
  });

  describe('OPEN → HALF_OPEN transition', () => {
    it('transitions to HALF_OPEN after openDurationMs', () => {
      const realDateNow = Date.now;
      const baseTime = realDateNow.call(Date);

      Date.now = jest.fn(() => baseTime);
      // Open the circuit
      for (let i = 0; i < 5; i++) {
        recordAuthFailure();
      }
      expect(getCircuitState().state).toBe('OPEN');

      // Advance past openDurationMs (60s)
      Date.now = jest.fn(() => baseTime + 61000);
      const state = getCircuitState(); // triggers updateCircuitState
      expect(state.state).toBe('HALF_OPEN');
      expect(canMakeAuthRequest()).toBe(true);

      Date.now = realDateNow;
    });
  });

  describe('HALF_OPEN behavior', () => {
    let realDateNow: () => number;
    let baseTime: number;

    beforeEach(() => {
      realDateNow = Date.now;
      baseTime = realDateNow.call(Date);

      // Get to HALF_OPEN state
      Date.now = jest.fn(() => baseTime);
      for (let i = 0; i < 5; i++) {
        recordAuthFailure();
      }
      Date.now = jest.fn(() => baseTime + 61000);
      getCircuitState(); // trigger transition to HALF_OPEN
    });

    afterEach(() => {
      Date.now = realDateNow;
    });

    it('closes circuit after enough successes in HALF_OPEN', () => {
      Date.now = jest.fn(() => baseTime + 62000);
      recordAuthSuccess();
      recordAuthSuccess();
      expect(getCircuitState().state).toBe('CLOSED');
    });

    it('reopens circuit on failure in HALF_OPEN', () => {
      Date.now = jest.fn(() => baseTime + 62000);
      recordAuthFailure();
      expect(getCircuitState().state).toBe('OPEN');
    });
  });

  describe('withCircuitBreaker wrapper', () => {
    it('returns result on success', async () => {
      const result = await withCircuitBreaker(() => Promise.resolve('ok'));
      expect(result.result).toBe('ok');
      expect(result.circuitOpen).toBe(false);
    });

    it('records failure and returns fallback on error', async () => {
      const result = await withCircuitBreaker(
        () => Promise.reject(new Error('auth down')),
        'fallback'
      );
      expect(result.result).toBe('fallback');
      expect(result.error?.message).toBe('auth down');
      expect(getCircuitState().failureCount).toBe(1);
    });

    it('returns circuitOpen=true when circuit is open', async () => {
      // Open the circuit
      for (let i = 0; i < 5; i++) {
        recordAuthFailure();
      }
      const result = await withCircuitBreaker(
        () => Promise.resolve('should not run'),
        'blocked'
      );
      expect(result.circuitOpen).toBe(true);
      expect(result.result).toBe('blocked');
    });
  });

  describe('resetCircuit', () => {
    it('resets all state to initial values', () => {
      for (let i = 0; i < 5; i++) {
        recordAuthFailure();
      }
      expect(getCircuitState().state).toBe('OPEN');

      resetCircuit();
      const state = getCircuitState();
      expect(state.state).toBe('CLOSED');
      expect(state.failureCount).toBe(0);
      expect(state.successCount).toBe(0);
      expect(state.openedAt).toBeNull();
    });
  });
});
