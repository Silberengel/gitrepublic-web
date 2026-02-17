/**
 * Logger interface for consistent logging across the application
 * Compatible with both pino (server-side) and console (browser-side)
 */

export interface Logger {
  info(...args: unknown[]): void;
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  trace(...args: unknown[]): void;
  fatal(...args: unknown[]): void;
}
