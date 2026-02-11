/**
 * Worker Error Boundary - Global Error Handling for BullMQ Workers
 * 
 * QA Enhancement EH-001: Provides a unified error handling wrapper for all worker processors
 * to ensure consistent error logging, monitoring, and graceful degradation.
 */

import { Job, UnrecoverableError } from 'bullmq';
import { logger } from './logger';
import { prisma } from './prisma';
import { 
  createCorrelationContext, 
  createDeadLetterEntry, 
  shouldMoveToDeadLetter,
  recordHeartbeat,
  registerActiveJob,
  unregisterActiveJob,
  isShuttingDown,
  canAcceptNewJobs,
  getWorkerId,
  recordCircuitFailure,
  recordCircuitSuccess,
  canExecute,
} from './bug-fixes/workers-concurrency';

// Error categories for monitoring and alerting
export enum WorkerErrorCategory {
  TRANSIENT = 'transient',       // Network, timeout - retry
  DATA_INTEGRITY = 'data_integrity', // Invalid data - needs attention
  DEPENDENCY = 'dependency',     // External service down - circuit breaker
  BUSINESS_LOGIC = 'business_logic', // App logic error - may be permanent
  UNRECOVERABLE = 'unrecoverable', // Permanent failure - DLQ
}

export interface WorkerErrorDetails {
  category: WorkerErrorCategory;
  shouldRetry: boolean;
  message: string;
  code?: string;
  context?: Record<string, unknown>;
}

// Known error patterns and their categories
const ERROR_PATTERNS: Array<{ pattern: RegExp; category: WorkerErrorCategory; shouldRetry: boolean }> = [
  // Circuit breaker errors - should NOT retry immediately (breaker handles timing)
  { pattern: /circuit.*breaker.*open|CIRCUIT_OPEN/i, category: WorkerErrorCategory.DEPENDENCY, shouldRetry: false },
  { pattern: /CircuitBreakerOpenError/i, category: WorkerErrorCategory.DEPENDENCY, shouldRetry: false },
  
  // Transient errors - should retry
  { pattern: /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET/i, category: WorkerErrorCategory.TRANSIENT, shouldRetry: true },
  { pattern: /connection.*refused|network.*error/i, category: WorkerErrorCategory.TRANSIENT, shouldRetry: true },
  { pattern: /timeout|timed out/i, category: WorkerErrorCategory.TRANSIENT, shouldRetry: true },
  { pattern: /rate.?limit|too many requests|429/i, category: WorkerErrorCategory.TRANSIENT, shouldRetry: true },
  { pattern: /temporary|unavailable|503|502/i, category: WorkerErrorCategory.TRANSIENT, shouldRetry: true },
  { pattern: /dns.*resolution.*failed|DnsError/i, category: WorkerErrorCategory.TRANSIENT, shouldRetry: true },
  
  // Data integrity - review needed
  { pattern: /foreign key|constraint violation|unique constraint/i, category: WorkerErrorCategory.DATA_INTEGRITY, shouldRetry: false },
  { pattern: /invalid.*uuid|malformed/i, category: WorkerErrorCategory.DATA_INTEGRITY, shouldRetry: false },
  { pattern: /not found|does not exist/i, category: WorkerErrorCategory.DATA_INTEGRITY, shouldRetry: false },
  
  // Dependency failures - circuit breaker
  { pattern: /external.*service|api.*error/i, category: WorkerErrorCategory.DEPENDENCY, shouldRetry: true },
  { pattern: /redis|database.*connection/i, category: WorkerErrorCategory.DEPENDENCY, shouldRetry: true },
  
  // Scraper-specific errors
  { pattern: /proxy.*blocked|ProxyBlockedError/i, category: WorkerErrorCategory.DEPENDENCY, shouldRetry: true },
  { pattern: /PROVIDER_NOT_IMPLEMENTED/i, category: WorkerErrorCategory.UNRECOVERABLE, shouldRetry: false },
  
  // Business logic - may need code fix
  { pattern: /assertion|invariant/i, category: WorkerErrorCategory.BUSINESS_LOGIC, shouldRetry: false },
  { pattern: /validation|schema/i, category: WorkerErrorCategory.BUSINESS_LOGIC, shouldRetry: false },
];

/**
 * Categorize an error based on its message and type
 */
export function categorizeError(error: Error): WorkerErrorDetails {
  const message = error.message || 'Unknown error';
  
  for (const { pattern, category, shouldRetry } of ERROR_PATTERNS) {
    if (pattern.test(message)) {
      return { category, shouldRetry, message };
    }
  }
  
  // Check for Prisma-specific errors
  if ('code' in error) {
    const code = (error as any).code;
    if (code?.startsWith('P2')) {
      // Prisma query errors
      return {
        category: WorkerErrorCategory.DATA_INTEGRITY,
        shouldRetry: false,
        message,
        code,
      };
    }
  }
  
  // Default to business logic error (unknown errors)
  return {
    category: WorkerErrorCategory.BUSINESS_LOGIC,
    shouldRetry: true,
    message,
  };
}

/**
 * Worker processor wrapper type
 */
type WorkerProcessor<T = unknown, R = void> = (job: Job<T>) => Promise<R>;

/**
 * Options for the worker error boundary
 */
export interface WorkerErrorBoundaryOptions {
  /** Maximum number of retries before moving to DLQ */
  maxRetries?: number;
  /** Enable circuit breaker for external dependencies */
  circuitBreakerName?: string;
  /** Timeout for the processor in milliseconds */
  timeoutMs?: number;
  /** Custom error handler */
  onError?: (error: Error, job: Job, details: WorkerErrorDetails) => Promise<void>;
  /** Custom success handler */
  onSuccess?: (job: Job, result: any) => Promise<void>;
  /** Whether to log job payloads (disable for sensitive data) */
  logPayload?: boolean;
}

const DEFAULT_OPTIONS: WorkerErrorBoundaryOptions = {
  maxRetries: 5,
  timeoutMs: 300000, // 5 minutes default
  logPayload: true,
};

/**
 * Wraps a worker processor with global error boundary
 * 
 * Features:
 * - Consistent error categorization and logging
 * - Circuit breaker integration
 * - Dead letter queue support
 * - Correlation ID tracking
 * - Graceful shutdown awareness
 * - Job attempt tracking
 * - Heartbeat reporting
 */
export function withWorkerErrorBoundary<T = unknown, R = void>(
  processorName: string,
  processor: WorkerProcessor<T, R>,
  options: WorkerErrorBoundaryOptions = {}
): WorkerProcessor<T, R> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  
  return async (job: Job<T>): Promise<R> => {
    const context = createCorrelationContext({ jobId: job.id });
    const startTime = Date.now();
    const workerId = getWorkerId();
    
    // Check if we should accept new jobs
    if (!canAcceptNewJobs()) {
      logger.warn('Worker shutting down, skipping job', {
        processorName,
        jobId: job.id,
        correlationId: context.correlationId,
      });
      throw new Error('Worker is shutting down');
    }
    
    // Check circuit breaker if configured
    if (opts.circuitBreakerName && !canExecute(opts.circuitBreakerName)) {
      logger.warn('Circuit breaker open, rejecting job', {
        processorName,
        jobId: job.id,
        circuitBreaker: opts.circuitBreakerName,
      });
      throw new Error(`Circuit breaker open: ${opts.circuitBreakerName}`);
    }
    
    // Register active job for graceful shutdown
    registerActiveJob(job.id!);
    recordHeartbeat(job.id, new Date());
    
    logger.info(`[${processorName}] Starting job`, {
      jobId: job.id,
      attemptsMade: job.attemptsMade,
      correlationId: context.correlationId,
      workerId,
      ...(opts.logPayload ? { payload: job.data } : {}),
    });
    
    try {
      // Execute with timeout if configured
      let result: R;
      
      if (opts.timeoutMs) {
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error(`Job timeout after ${opts.timeoutMs}ms`)), opts.timeoutMs);
        });
        result = await Promise.race([processor(job), timeoutPromise]);
      } else {
        result = await processor(job);
      }
      
      const durationMs = Date.now() - startTime;
      
      // Record success
      if (opts.circuitBreakerName) {
        recordCircuitSuccess(opts.circuitBreakerName);
      }
      
      logger.info(`[${processorName}] Job completed`, {
        jobId: job.id,
        durationMs,
        correlationId: context.correlationId,
      });
      
      // Custom success handler
      if (opts.onSuccess) {
        await opts.onSuccess(job, result).catch(err => {
          logger.warn('onSuccess handler failed', { error: err.message });
        });
      }
      
      recordHeartbeat(null, null);
      unregisterActiveJob(job.id!);
      
      return result;
      
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      const errorDetails = categorizeError(err);
      const durationMs = Date.now() - startTime;
      
      // Record failure for circuit breaker
      if (opts.circuitBreakerName && errorDetails.category === WorkerErrorCategory.DEPENDENCY) {
        recordCircuitFailure(opts.circuitBreakerName);
      }
      
      logger.error(`[${processorName}] Job failed`, {
        jobId: job.id,
        attemptsMade: job.attemptsMade,
        durationMs,
        correlationId: context.correlationId,
        error: err.message,
        errorCategory: errorDetails.category,
        shouldRetry: errorDetails.shouldRetry,
        stack: err.stack?.split('\n').slice(0, 5).join('\n'),
      });
      
      // Custom error handler
      if (opts.onError) {
        await opts.onError(err, job, errorDetails).catch(handlerErr => {
          logger.warn('onError handler failed', { error: handlerErr.message });
        });
      }
      
      // Check if we should move to DLQ
      const maxRetries = opts.maxRetries || 5;
      if (shouldMoveToDeadLetter(job.attemptsMade + 1, maxRetries)) {
        const dlqEntry = createDeadLetterEntry(
          job.queueName,
          job.id!,
          job.data,
          err,
          job.attemptsMade + 1,
          maxRetries
        );
        
        // Store in DLQ table (WorkerFailure)
        try {
          await prisma.workerFailure.create({
            data: {
              queue_name: dlqEntry.queueName,
              job_id: dlqEntry.jobId,
              payload: dlqEntry.payload as any,
              error_message: dlqEntry.errorMessage,
              stack_trace: dlqEntry.stackTrace,
              attempts_made: dlqEntry.attemptsMade,
            },
          });
          
          logger.warn(`[${processorName}] Job moved to DLQ`, {
            jobId: job.id,
            dlqId: dlqEntry.id,
            attemptsMade: job.attemptsMade + 1,
          });
        } catch (dlqError: unknown) {
          logger.error('Failed to store job in DLQ', {
            jobId: job.id,
            error: dlqError instanceof Error ? dlqError.message : String(dlqError),
          });
        }
        
        // Throw UnrecoverableError to prevent further retries
        throw new UnrecoverableError(err.message);
      }
      
      // For non-retryable errors, throw UnrecoverableError
      if (!errorDetails.shouldRetry) {
        logger.warn(`[${processorName}] Non-retryable error, marking as unrecoverable`, {
          jobId: job.id,
          category: errorDetails.category,
        });
        throw new UnrecoverableError(err.message);
      }
      
      recordHeartbeat(null, null);
      unregisterActiveJob(job.id!);
      
      // Re-throw for BullMQ to handle retry
      throw err;
    }
  };
}

/**
 * Transaction timeout error class for EH-003
 */
export class TransactionTimeoutError extends Error {
  constructor(message: string, public readonly durationMs: number) {
    super(message);
    this.name = 'TransactionTimeoutError';
  }
}

/**
 * EH-003: Execute a function with transaction timeout handling
 */
export async function withTransactionTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number = 15000,
  context?: { jobId?: string; operation?: string }
): Promise<T> {
  const startTime = Date.now();
  
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      const duration = Date.now() - startTime;
      const error = new TransactionTimeoutError(
        `Transaction timeout after ${duration}ms (limit: ${timeoutMs}ms)`,
        duration
      );
      reject(error);
    }, timeoutMs);
  });
  
  try {
    return await Promise.race([fn(), timeoutPromise]);
  } catch (error: unknown) {
    if (error instanceof TransactionTimeoutError) {
      logger.error('Transaction timeout', {
        durationMs: error.durationMs,
        limitMs: timeoutMs,
        ...context,
      });
    }
    throw error;
  }
}

/**
 * EH-004: Add request context to error logs
 */
export interface RequestContext {
  requestId: string;
  userId?: string;
  path?: string;
  method?: string;
  userAgent?: string;
  ip?: string;
}

let currentRequestContext: RequestContext | null = null;

export function setRequestContext(context: RequestContext): void {
  currentRequestContext = context;
}

export function clearRequestContext(): void {
  currentRequestContext = null;
}

export function getRequestContext(): RequestContext | null {
  return currentRequestContext;
}

/**
 * Enhanced error logging with request context
 */
export function logErrorWithContext(
  message: string,
  error: Error,
  additionalContext?: Record<string, unknown>
): void {
  const requestContext = getRequestContext();
  
  logger.error(message, {
    error: error.message,
    stack: error.stack?.split('\n').slice(0, 10).join('\n'),
    ...(requestContext || {}),
    ...additionalContext,
  });
}
