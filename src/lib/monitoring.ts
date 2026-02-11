import { logger } from './logger';

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

interface ErrorContext {
  requestId?: string;
  userId?: string;
  path?: string;
  method?: string;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  [key: string]: unknown;
}

interface MonitoringConfig {
  dsn?: string;
  environment?: string;
  release?: string;
  sampleRate?: number;
  enabled?: boolean;
}

class ErrorMonitoring {
  private config: MonitoringConfig = {
    dsn: process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.NODE_ENV,
    release: process.env.NEXT_PUBLIC_APP_VERSION,
    sampleRate: 1.0,
    enabled: process.env.NODE_ENV === 'production',
  };

  private isInitialized = false;
  private queue: Array<{ error: Error; context?: ErrorContext }> = [];

  async init(overrides?: Partial<MonitoringConfig>) {
    if (this.isInitialized) return;
    
    this.config = { ...this.config, ...overrides };

    if (!this.config.dsn || !this.config.enabled) {
      this.isInitialized = true;
      return;
    }

    try {
      this.isInitialized = true;
      this.processQueue();
    } catch (err: unknown) {
      logger.warn('Failed to initialize error monitoring:', err);
    }
  }

  private processQueue() {
    while (this.queue.length > 0) {
      const item = this.queue.shift();
      if (item) {
        this.captureException(item.error, item.context);
      }
    }
  }

  captureException(error: Error, context?: ErrorContext) {
    if (!this.isInitialized) {
      this.queue.push({ error, context });
      return;
    }

    if (!this.config.dsn || !this.config.enabled) {
      return;
    }

    if (this.config.sampleRate && Math.random() > this.config.sampleRate) {
      return;
    }

    logger.error('[ErrorMonitoring] Captured exception:', {
      name: error.name,
      message: error.message,
      requestId: context?.requestId,
      userId: context?.userId,
      path: context?.path,
    });
  }

  captureMessage(message: string, level: LogLevel = 'info', context?: ErrorContext) {
    if (!this.config.dsn || !this.config.enabled) {
      return;
    }

    logger.info(`[ErrorMonitoring] ${level.toUpperCase()}: ${message}`, context);
  }

  setUser(user: { id: string; email?: string; username?: string } | null) {
    if (!this.config.dsn || !this.config.enabled) {
      return;
    }
  }

  addBreadcrumb(breadcrumb: {
    category?: string;
    message: string;
    level?: LogLevel;
    data?: Record<string, unknown>;
  }) {
    if (!this.config.dsn || !this.config.enabled) {
      return;
    }
  }

  withScope<T>(callback: (scope: ErrorContext) => T): T {
    const scope: ErrorContext = {};
    return callback(scope);
  }

  async flush(timeout?: number): Promise<boolean> {
    return true;
  }
}

export const errorMonitoring = new ErrorMonitoring();

export function captureException(error: Error, context?: ErrorContext) {
  errorMonitoring.captureException(error, context);
}

export function captureMessage(message: string, level?: LogLevel, context?: ErrorContext) {
  errorMonitoring.captureMessage(message, level, context);
}

export function setUser(user: { id: string; email?: string; username?: string } | null) {
  errorMonitoring.setUser(user);
}

export function addBreadcrumb(breadcrumb: {
  category?: string;
  message: string;
  level?: LogLevel;
  data?: Record<string, unknown>;
}) {
  errorMonitoring.addBreadcrumb(breadcrumb);
}

export async function initMonitoring(config?: Partial<MonitoringConfig>) {
  await errorMonitoring.init(config);
}

// =============================================================================
// DLQ MONITORING & ALERTING
// =============================================================================

export interface DLQAlert {
  type: 'dlq_threshold' | 'dlq_critical' | 'metadata_failure' | 'source_failure' | 'system_error';
  entityId?: string;
  failureCount: number;
  message: string;
  timestamp: Date;
  severity: 'warning' | 'error' | 'critical';
}

export type AlertHandler = (alert: DLQAlert) => void | Promise<void>;

class DLQAlertingService {
  private handlers: AlertHandler[] = [];
  private lastAlertTime = new Map<string, number>();
  private readonly alertCooldownMs = 5 * 60 * 1000; // 5 minutes between same alerts

  registerHandler(handler: AlertHandler): () => void {
    this.handlers.push(handler);
    return () => {
      const index = this.handlers.indexOf(handler);
      if (index > -1) this.handlers.splice(index, 1);
    };
  }

  async sendAlert(alert: DLQAlert): Promise<void> {
    const alertKey = `${alert.type}:${alert.entityId || 'global'}`;
    const now = Date.now();
    const lastAlert = this.lastAlertTime.get(alertKey);

    if (lastAlert && now - lastAlert < this.alertCooldownMs) {
      return;
    }

    this.lastAlertTime.set(alertKey, now);

    logger.error(`[DLQ_ALERT] ${alert.severity.toUpperCase()}: ${alert.message}`, {
      type: alert.type,
      entityId: alert.entityId,
      failureCount: alert.failureCount,
      timestamp: alert.timestamp.toISOString(),
    });

    for (const handler of this.handlers) {
      try {
        await handler(alert);
      } catch (err: unknown) {
        logger.error('[DLQ_ALERT] Handler error:', err);
      }
    }

    errorMonitoring.captureMessage(alert.message, alert.severity === 'critical' ? 'error' : 'warn', {
      tags: { alertType: alert.type, severity: alert.severity },
      extra: { failureCount: alert.failureCount, entityId: alert.entityId },
    });
  }

  async checkDLQThresholds(dlqCount: number, thresholds = { warning: 50, error: 200, critical: 500 }): Promise<void> {
    if (dlqCount >= thresholds.critical) {
      await this.sendAlert({
        type: 'dlq_critical',
        failureCount: dlqCount,
        message: `CRITICAL: DLQ has ${dlqCount} unresolved failures (threshold: ${thresholds.critical})`,
        timestamp: new Date(),
        severity: 'critical',
      });
    } else if (dlqCount >= thresholds.error) {
      await this.sendAlert({
        type: 'dlq_threshold',
        failureCount: dlqCount,
        message: `ERROR: DLQ has ${dlqCount} unresolved failures (threshold: ${thresholds.error})`,
        timestamp: new Date(),
        severity: 'error',
      });
    } else if (dlqCount >= thresholds.warning) {
      await this.sendAlert({
        type: 'dlq_threshold',
        failureCount: dlqCount,
        message: `WARNING: DLQ has ${dlqCount} unresolved failures (threshold: ${thresholds.warning})`,
        timestamp: new Date(),
        severity: 'warning',
      });
    }
  }
}

export const dlqAlerting = new DLQAlertingService();

export function registerDLQAlertHandler(handler: AlertHandler): () => void {
  return dlqAlerting.registerHandler(handler);
}

export async function checkDLQHealth(dlqCount: number): Promise<void> {
  return dlqAlerting.checkDLQThresholds(dlqCount);
}

// =============================================================================
// PERF-003: Worker Concurrency Monitoring
// =============================================================================

export interface WorkerMetrics {
  queueName: string;
  activeJobs: number;
  waitingJobs: number;
  completedJobs: number;
  failedJobs: number;
  delayedJobs: number;
  processTime: {
    avg: number;
    p50: number;
    p95: number;
    p99: number;
  };
  throughput: {
    jobsPerMinute: number;
    jobsPerHour: number;
  };
  healthStatus: 'healthy' | 'degraded' | 'critical';
  timestamp: Date;
}

export interface ConcurrencyConfig {
  queueName: string;
  currentConcurrency: number;
  maxConcurrency: number;
  recommendedConcurrency: number;
  autoScale: boolean;
}

class WorkerConcurrencyMonitor {
  private metricsHistory: Map<string, WorkerMetrics[]> = new Map();
  private readonly maxHistoryLength = 60; // Keep 60 samples (1 hour at 1/min)
  
  private concurrencyConfigs: Map<string, ConcurrencyConfig> = new Map();
  
  /**
   * Record worker metrics for a queue
   */
  recordMetrics(metrics: WorkerMetrics): void {
    const history = this.metricsHistory.get(metrics.queueName) || [];
    history.push(metrics);
    
    // Keep only recent history
    if (history.length > this.maxHistoryLength) {
      history.shift();
    }
    
    this.metricsHistory.set(metrics.queueName, history);
    
    // Log if degraded or critical
    if (metrics.healthStatus === 'degraded') {
      logger.warn(`[WorkerMonitor] ${metrics.queueName} is DEGRADED`, {
        activeJobs: metrics.activeJobs,
        waitingJobs: metrics.waitingJobs,
        failedJobs: metrics.failedJobs,
      });
    } else if (metrics.healthStatus === 'critical') {
      logger.error(`[WorkerMonitor] ${metrics.queueName} is CRITICAL`, {
        activeJobs: metrics.activeJobs,
        waitingJobs: metrics.waitingJobs,
        failedJobs: metrics.failedJobs,
      });
    }
  }

  /**
   * Get current metrics for a queue
   */
  getCurrentMetrics(queueName: string): WorkerMetrics | null {
    const history = this.metricsHistory.get(queueName);
    return history && history.length > 0 ? history[history.length - 1] : null;
  }

  /**
   * Get metrics history for a queue
   */
  getMetricsHistory(queueName: string, limit?: number): WorkerMetrics[] {
    const history = this.metricsHistory.get(queueName) || [];
    return limit ? history.slice(-limit) : history;
  }

  /**
   * Calculate recommended concurrency based on queue metrics
   */
  calculateRecommendedConcurrency(
    queueName: string,
    currentConcurrency: number,
    maxConcurrency: number
  ): number {
    const history = this.getMetricsHistory(queueName, 10);
    if (history.length < 5) return currentConcurrency;

    // Calculate average waiting jobs and process time
    const avgWaiting = history.reduce((sum, m) => sum + m.waitingJobs, 0) / history.length;
    const avgActive = history.reduce((sum, m) => sum + m.activeJobs, 0) / history.length;
    const avgFailed = history.reduce((sum, m) => sum + m.failedJobs, 0) / history.length;
    const avgProcessTime = history.reduce((sum, m) => sum + m.processTime.avg, 0) / history.length;

    let recommended = currentConcurrency;

    // Scale up if waiting queue is growing and we're at capacity
    if (avgWaiting > currentConcurrency * 2 && avgActive >= currentConcurrency * 0.8) {
      recommended = Math.min(currentConcurrency + 2, maxConcurrency);
    }

    // Scale down if queue is mostly empty
    if (avgWaiting < currentConcurrency * 0.3 && avgActive < currentConcurrency * 0.5) {
      recommended = Math.max(Math.floor(currentConcurrency * 0.8), 1);
    }

    // Reduce concurrency if failure rate is high (> 10%)
    const totalJobs = avgActive + avgFailed;
    if (totalJobs > 0 && avgFailed / totalJobs > 0.1) {
      recommended = Math.max(Math.floor(currentConcurrency * 0.7), 1);
    }

    // Reduce concurrency if process time is very high (> 30 seconds avg)
    if (avgProcessTime > 30000) {
      recommended = Math.max(Math.floor(currentConcurrency * 0.8), 1);
    }

    return recommended;
  }

  /**
   * Get or create concurrency config for a queue
   */
  getConcurrencyConfig(
    queueName: string,
    defaults: { current: number; max: number; autoScale?: boolean } = { current: 5, max: 20, autoScale: false }
  ): ConcurrencyConfig {
    if (!this.concurrencyConfigs.has(queueName)) {
      this.concurrencyConfigs.set(queueName, {
        queueName,
        currentConcurrency: defaults.current,
        maxConcurrency: defaults.max,
        recommendedConcurrency: defaults.current,
        autoScale: defaults.autoScale ?? false,
      });
    }
    return this.concurrencyConfigs.get(queueName)!;
  }

  /**
   * Update concurrency recommendation for a queue
   */
  updateConcurrencyRecommendation(queueName: string): ConcurrencyConfig {
    const config = this.getConcurrencyConfig(queueName);
    config.recommendedConcurrency = this.calculateRecommendedConcurrency(
      queueName,
      config.currentConcurrency,
      config.maxConcurrency
    );
    return config;
  }

  /**
   * Get all queue metrics summary
   */
  getAllQueuesSummary(): Map<string, { current: WorkerMetrics | null; config: ConcurrencyConfig }> {
    const summary = new Map<string, { current: WorkerMetrics | null; config: ConcurrencyConfig }>();
    
    for (const [queueName] of this.metricsHistory) {
      summary.set(queueName, {
        current: this.getCurrentMetrics(queueName),
        config: this.getConcurrencyConfig(queueName),
      });
    }
    
    return summary;
  }

  /**
   * Determine health status based on metrics
   */
  static determineHealthStatus(
    activeJobs: number,
    waitingJobs: number,
    failedJobs: number,
    maxConcurrency: number
  ): 'healthy' | 'degraded' | 'critical' {
    // Critical if failure rate is very high
    if (failedJobs > activeJobs * 0.3) return 'critical';
    
    // Critical if waiting queue is extremely backed up
    if (waitingJobs > maxConcurrency * 10) return 'critical';
    
    // Degraded if waiting queue is growing
    if (waitingJobs > maxConcurrency * 3) return 'degraded';
    
    // Degraded if failure rate is elevated
    if (failedJobs > activeJobs * 0.1) return 'degraded';
    
    return 'healthy';
  }
}

export const workerMonitor = new WorkerConcurrencyMonitor();

/**
 * Record worker metrics for monitoring
 */
export function recordWorkerMetrics(metrics: WorkerMetrics): void {
  workerMonitor.recordMetrics(metrics);
}

/**
 * Get current metrics for a queue
 */
export function getWorkerMetrics(queueName: string): WorkerMetrics | null {
  return workerMonitor.getCurrentMetrics(queueName);
}

/**
 * Get concurrency recommendation for a queue
 */
export function getConcurrencyRecommendation(queueName: string): ConcurrencyConfig {
  return workerMonitor.updateConcurrencyRecommendation(queueName);
}

/**
 * Get all queues summary
 */
export function getAllWorkersSummary(): Map<string, { current: WorkerMetrics | null; config: ConcurrencyConfig }> {
  return workerMonitor.getAllQueuesSummary();
}

/**
 * Helper to create worker metrics from BullMQ queue stats
 */
export function createWorkerMetricsFromQueue(
  queueName: string,
  stats: {
    active: number;
    waiting: number;
    completed: number;
    failed: number;
    delayed: number;
  },
  processTimeStats: {
    avg: number;
    p50?: number;
    p95?: number;
    p99?: number;
  },
  maxConcurrency: number = 10
): WorkerMetrics {
  return {
    queueName,
    activeJobs: stats.active,
    waitingJobs: stats.waiting,
    completedJobs: stats.completed,
    failedJobs: stats.failed,
    delayedJobs: stats.delayed,
    processTime: {
      avg: processTimeStats.avg,
      p50: processTimeStats.p50 ?? processTimeStats.avg,
      p95: processTimeStats.p95 ?? processTimeStats.avg * 1.5,
      p99: processTimeStats.p99 ?? processTimeStats.avg * 2,
    },
    throughput: {
      jobsPerMinute: stats.completed > 0 ? Math.round(stats.completed / 60) : 0,
      jobsPerHour: stats.completed,
    },
    healthStatus: WorkerConcurrencyMonitor.determineHealthStatus(
      stats.active,
      stats.waiting,
      stats.failed,
      maxConcurrency
    ),
    timestamp: new Date(),
  };
}
