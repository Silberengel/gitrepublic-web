/**
 * Pino logger service
 * Provides structured logging with pino-pretty for development
 * Browser-safe: falls back to console in browser environments
 */

import type { Logger } from '../types/logger.js';

function createConsoleLogger(): Logger {
  return {
    info: (...args: unknown[]) => console.log('[INFO]', ...args),
    error: (...args: unknown[]) => console.error('[ERROR]', ...args),
    warn: (...args: unknown[]) => console.warn('[WARN]', ...args),
    debug: (...args: unknown[]) => console.debug('[DEBUG]', ...args),
    trace: (...args: unknown[]) => console.trace('[TRACE]', ...args),
    fatal: (...args: unknown[]) => console.error('[FATAL]', ...args)
  };
}

// Check if we're in a Node.js environment
const isNode = typeof process !== 'undefined' && process.versions?.node;

let logger: Logger;

if (isNode) {
  // Server-side: use pino
  // Use dynamic import to avoid bundling for browser
  const initPino = async () => {
    try {
      const pinoModule = await import('pino');
      const pino = pinoModule.default;
      const logLevel = (typeof process !== 'undefined' && process.env?.LOG_LEVEL) || 'info';
      const isDev = typeof process !== 'undefined' && process.env?.NODE_ENV === 'development';
      
      return pino({
        level: logLevel,
        ...(isDev && {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'HH:MM:ss Z',
              ignore: 'pid,hostname'
            }
          }
        })
      });
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
  // Browser-side: use console with similar API
  logger = createConsoleLogger();
}

export default logger;
