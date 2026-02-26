/**
 * Enhanced logging service with better console output and noise reduction
 * Provides structured logging with pino for production, enhanced console for development
 * Browser-safe: falls back to console in browser environments
 */

import type { Logger } from '../types/logger.js';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

interface LogContext {
  [key: string]: unknown;
}

interface EnhancedLogger extends Logger {
  logWithContext(level: LogLevel, message: string, context?: LogContext): void;
  performance(label: string, fn: () => Promise<unknown> | unknown): Promise<unknown>;
  security(action: string, context?: LogContext): void;
  operation(operation: string, context?: LogContext): void;
}

function formatContext(context?: LogContext): string {
  if (!context || Object.keys(context).length === 0) return '';
  try {
    return ' ' + JSON.stringify(context, null, 0);
  } catch {
    return ' [context serialization failed]';
  }
}

function shouldLog(level: LogLevel, minLevel: LogLevel = 'info'): boolean {
  const levels: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
  return levels.indexOf(level) >= levels.indexOf(minLevel);
}

function createConsoleLogger(): EnhancedLogger {
  const minLevel = (typeof process !== 'undefined' && process.env?.LOG_LEVEL as LogLevel) || 'info';
  const isDev = typeof process !== 'undefined' && process.env?.NODE_ENV === 'development';
  
  const baseLogger = {
    info: (message: string, ...args: unknown[]) => {
      if (shouldLog('info', minLevel)) {
        console.log(`[INFO] ${message}`, ...args);
      }
    },
    error: (message: string, ...args: unknown[]) => {
      if (shouldLog('error', minLevel)) {
        console.error(`[ERROR] ${message}`, ...args);
      }
    },
    warn: (message: string, ...args: unknown[]) => {
      if (shouldLog('warn', minLevel)) {
        console.warn(`[WARN] ${message}`, ...args);
      }
    },
    debug: (message: string, ...args: unknown[]) => {
      if (shouldLog('debug', minLevel)) {
        console.debug(`[DEBUG] ${message}`, ...args);
      }
    },
    trace: (message: string, ...args: unknown[]) => {
      if (shouldLog('trace', minLevel)) {
        console.trace(`[TRACE] ${message}`, ...args);
      }
    },
    fatal: (message: string, ...args: unknown[]) => {
      console.error(`[FATAL] ${message}`, ...args);
    },
    logWithContext: (level: LogLevel, message: string, context?: LogContext) => {
      if (!shouldLog(level, minLevel)) return;
      const contextStr = formatContext(context);
      const timestamp = new Date().toISOString();
      const prefix = `[${timestamp}] [${level.toUpperCase()}]`;
      
      switch (level) {
        case 'error':
        case 'fatal':
          console.error(`${prefix} ${message}${contextStr}`);
          break;
        case 'warn':
          console.warn(`${prefix} ${message}${contextStr}`);
          break;
        case 'debug':
        case 'trace':
          console.debug(`${prefix} ${message}${contextStr}`);
          break;
        default:
          console.log(`${prefix} ${message}${contextStr}`);
      }
    },
    performance: async (label: string, fn: () => Promise<unknown> | unknown) => {
      const start = performance.now();
      try {
        const result = await fn();
        const duration = performance.now() - start;
        if (duration > 100 || isDev) {
          console.log(`[PERF] ${label} took ${duration.toFixed(2)}ms`);
        }
        return result;
      } catch (error) {
        const duration = performance.now() - start;
        console.error(`[PERF] ${label} failed after ${duration.toFixed(2)}ms:`, error);
        throw error;
      }
    },
    security: (action: string, context?: LogContext) => {
      const contextStr = formatContext(context);
      const timestamp = new Date().toISOString();
      console.warn(`[SECURITY] [${timestamp}] ${action}${contextStr}`);
    },
    operation: (operation: string, context?: LogContext) => {
      if (isDev || shouldLog('info', minLevel)) {
        const contextStr = formatContext(context);
        const timestamp = new Date().toISOString();
        console.log(`[OP] [${timestamp}] ${operation}${contextStr}`);
      }
    }
  };
  
  return baseLogger as EnhancedLogger;
}

// Check if we're in a Node.js environment
const isNode = typeof process !== 'undefined' && process.versions?.node;

let logger: EnhancedLogger;

if (isNode) {
  // Server-side: use pino with enhanced console output
  const initPino = async () => {
    try {
      const pinoModule = await import('pino');
      const pino = pinoModule.default;
      const logLevel = (typeof process !== 'undefined' && process.env?.LOG_LEVEL) || 'info';
      const isDev = typeof process !== 'undefined' && process.env?.NODE_ENV === 'development';
      
      const pinoLogger = pino({
        level: logLevel,
        ...(isDev && {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'HH:MM:ss Z',
              ignore: 'pid,hostname',
              singleLine: false
            }
          }
        })
      });
      
      // Enhance pino logger with console methods
      const enhanced = createConsoleLogger();
      return {
        ...pinoLogger,
        logWithContext: enhanced.logWithContext,
        performance: enhanced.performance,
        security: enhanced.security,
        operation: enhanced.operation,
        // Override pino methods to also log to console in dev
        info: (obj: unknown, msg?: string, ...args: unknown[]) => {
          pinoLogger.info(obj, msg, ...args);
          if (isDev) enhanced.info(typeof msg === 'string' ? msg : String(obj), ...args);
        },
        error: (obj: unknown, msg?: string, ...args: unknown[]) => {
          pinoLogger.error(obj, msg, ...args);
          enhanced.error(typeof msg === 'string' ? msg : String(obj), ...args);
        },
        warn: (obj: unknown, msg?: string, ...args: unknown[]) => {
          pinoLogger.warn(obj, msg, ...args);
          if (isDev) enhanced.warn(typeof msg === 'string' ? msg : String(obj), ...args);
        },
        debug: (obj: unknown, msg?: string, ...args: unknown[]) => {
          pinoLogger.debug(obj, msg, ...args);
          if (isDev) enhanced.debug(typeof msg === 'string' ? msg : String(obj), ...args);
        },
        trace: (obj: unknown, msg?: string, ...args: unknown[]) => {
          pinoLogger.trace(obj, msg, ...args);
          if (isDev) enhanced.trace(typeof msg === 'string' ? msg : String(obj), ...args);
        },
        fatal: (obj: unknown, msg?: string, ...args: unknown[]) => {
          pinoLogger.fatal(obj, msg, ...args);
          enhanced.fatal(typeof msg === 'string' ? msg : String(obj), ...args);
        }
      } as EnhancedLogger;
    } catch {
      return createConsoleLogger();
    }
  };
  
  // Initialize with console logger first
  logger = createConsoleLogger();
  
  // Upgrade to pino asynchronously (non-blocking)
  initPino().then(pinoLogger => {
    // Replace the logger object
    Object.setPrototypeOf(logger, pinoLogger);
    Object.assign(logger, pinoLogger);
  }).catch(() => {
    // Keep console logger if pino fails
  });
} else {
  // Browser-side: use enhanced console
  logger = createConsoleLogger();
}

export default logger as EnhancedLogger;
