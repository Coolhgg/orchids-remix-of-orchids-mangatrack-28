/**
 * Logger with sensitive data redaction
 * 
 * Bug 89 Fix: Logger automatically redacts sensitive fields
 */

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

interface LogContext {
  requestId?: string;
  userId?: string;
  [key: string]: any;
}

/**
 * Sensitive field patterns to redact
 */
const SENSITIVE_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // API keys and tokens
  { pattern: /api[_-]?key[=:]\s*['"]?([^'"&\s]+)/gi, replacement: 'api_key=[REDACTED]' },
  { pattern: /bearer\s+([a-zA-Z0-9_.-]+)/gi, replacement: 'Bearer [REDACTED]' },
  { pattern: /token[=:]\s*['"]?([^'"&\s]+)/gi, replacement: 'token=[REDACTED]' },
  { pattern: /secret[=:]\s*['"]?([^'"&\s]+)/gi, replacement: 'secret=[REDACTED]' },
  
  // Passwords
  { pattern: /password[=:]\s*['"]?([^'"&\s]+)/gi, replacement: 'password=[REDACTED]' },
  
  // URLs with credentials
  { pattern: /https?:\/\/([^:]+):([^@]+)@/gi, replacement: 'https://[USER]:[REDACTED]@' },
  
  // Database connection strings
  { pattern: /postgres(ql)?:\/\/[^:]+:[^@]+@/gi, replacement: 'postgresql://[USER]:[REDACTED]@' },
  { pattern: /redis:\/\/[^:]+:[^@]+@/gi, replacement: 'redis://[USER]:[REDACTED]@' },
  
  // Session IDs
  { pattern: /session[_-]?id[=:]\s*['"]?([^'"&\s]+)/gi, replacement: 'session_id=[REDACTED]' },
];

/**
 * Sensitive object keys to redact
 */
const SENSITIVE_KEYS = new Set([
  'password', 'token', 'secret', 'apikey', 'api_key', 'apiKey',
  'authorization', 'auth', 'cookie', 'session', 'sessionid', 'session_id',
  'access_token', 'accessToken', 'refresh_token', 'refreshToken',
  'private_key', 'privateKey', 'client_secret', 'clientSecret',
  'database_url', 'databaseUrl', 'redis_url', 'redisUrl',
  'supabase_key', 'supabaseKey', 'service_role_key',
]);

/**
 * Redact sensitive data from a string
 */
function redactString(input: string): string {
  if (!input) return input;
  let result = input;
  for (const { pattern, replacement } of SENSITIVE_PATTERNS) {
    // Reset lastIndex because of 'g' flag statefulness (v5 audit bug 14)
    pattern.lastIndex = 0;
    result = result.replace(pattern, replacement);
  }
  return result;
}

/**
 * Redact sensitive data from an object (deep)
 * SECURITY FIX: Enhanced circular reference detection with try-catch for safety
 */
function redactObject(obj: unknown, maxDepth: number = 5, seen: WeakSet<object> = new WeakSet()): unknown {
  try {
    if (maxDepth <= 0) return '[MAX_DEPTH_EXCEEDED]';
    
    if (obj === null || obj === undefined) return obj;
    
    if (typeof obj === 'string') {
      return redactString(obj);
    }
    
    if (typeof obj === 'object') {
      if (seen.has(obj as object)) {
        return '[CIRCULAR_REFERENCE]';
      }
      seen.add(obj as object);
    }
    
    // Handle Error objects (message/stack are non-enumerable)
    if (obj instanceof Error) {
      return redactObject(
        { ...obj, name: obj.name, message: obj.message, stack: obj.stack },
        maxDepth - 1,
        seen
      );
    }
    
    if (Array.isArray(obj)) {
      return obj.slice(0, 100).map(item => redactObject(item, maxDepth - 1, seen));
    }
    
    if (typeof obj === 'object') {
      const result: Record<string, unknown> = {};
      const entries = Object.entries(obj);
      const limitedEntries = entries.slice(0, 50);
      
      for (const [key, value] of limitedEntries) {
        const lowerKey = key.toLowerCase();
        if (SENSITIVE_KEYS.has(lowerKey)) {
          result[key] = '[REDACTED]';
        } else {
          result[key] = redactObject(value, maxDepth - 1, seen);
        }
      }
      
      if (entries.length > 50) {
        result['...truncated'] = `${entries.length - 50} more keys`;
      }
      
      return result;
    }
    
    return obj;
  } catch (error: unknown) {
    return '[REDACTION_ERROR]';
  }
}

class Logger {
  private isProduction = process.env.NODE_ENV === 'production';

  private formatMessage(level: LogLevel, message: string, context?: LogContext | unknown) {
    const timestamp = new Date().toISOString();
    
    // Bug 89: Redact sensitive data from message and context
    const redactedMessage = redactString(message);
    // Normalize non-object context values into a LogContext wrapper
    const normalizedContext: LogContext | undefined = context === undefined
      ? undefined
      : (typeof context === 'object' && context !== null && !Array.isArray(context))
        ? context as LogContext
        : { value: context };
    const redactedContext = normalizedContext ? redactObject(normalizedContext) as LogContext : undefined;
    
    const logData = {
      timestamp,
      level: level.toUpperCase(),
      message: redactedMessage,
      ...redactedContext,
    };

    if (this.isProduction) {
      return JSON.stringify(logData);
    }

    const contextStr = redactedContext ? ` ${JSON.stringify(redactedContext)}` : '';
    return `[${timestamp}] ${level.toUpperCase()}: ${redactedMessage}${contextStr}`;
  }

  info(message: string, context?: LogContext | unknown) {
    console.info(this.formatMessage('info', message, context));
  }

  warn(message: string, context?: LogContext | unknown) {
    console.warn(this.formatMessage('warn', message, context));
  }

  error(message: string, context?: LogContext | unknown) {
    console.error(this.formatMessage('error', message, context));
  }

  debug(message: string, context?: LogContext | unknown) {
    if (!this.isProduction) {
      console.debug(this.formatMessage('debug', message, context));
    }
  }
}

export const logger = new Logger();
