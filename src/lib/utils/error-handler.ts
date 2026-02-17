/**
 * Standardized error handling utilities
 * Provides consistent error handling, logging, and sanitization across the application
 */

import { error } from '@sveltejs/kit';
import logger from '../services/logger.js';
import { sanitizeError } from './security.js';

export interface ErrorContext {
  operation?: string;
  npub?: string;
  repo?: string;
  filePath?: string;
  branch?: string;
  [key: string]: unknown;
}

/**
 * Standardized error handler for API endpoints
 * Handles errors consistently with proper logging and sanitization
 */
export function handleApiError(
  err: unknown,
  context: ErrorContext = {},
  defaultMessage: string = 'An error occurred'
): ReturnType<typeof error> {
  const sanitizedError = sanitizeError(err);
  const errorMessage = err instanceof Error ? err.message : defaultMessage;
  
  // Log error with structured context (pino-style)
  logger.error({ 
    error: sanitizedError, 
    ...context 
  }, `API Error: ${errorMessage}`);
  
  // Return sanitized error response
  return error(500, sanitizedError);
}

/**
 * Handle validation errors (400 Bad Request)
 */
export function handleValidationError(
  message: string,
  context: ErrorContext = {}
): ReturnType<typeof error> {
  logger.warn(context, `Validation Error: ${message}`);
  return error(400, message);
}

/**
 * Handle authentication errors (401 Unauthorized)
 */
export function handleAuthError(
  message: string = 'Authentication required',
  context: ErrorContext = {}
): ReturnType<typeof error> {
  logger.warn(context, `Auth Error: ${message}`);
  return error(401, message);
}

/**
 * Handle authorization errors (403 Forbidden)
 */
export function handleAuthorizationError(
  message: string = 'Insufficient permissions',
  context: ErrorContext = {}
): ReturnType<typeof error> {
  logger.warn(context, `Authorization Error: ${message}`);
  return error(403, message);
}

/**
 * Handle not found errors (404 Not Found)
 */
export function handleNotFoundError(
  message: string = 'Resource not found',
  context: ErrorContext = {}
): ReturnType<typeof error> {
  logger.info(context, `Not Found: ${message}`);
  return error(404, message);
}

/**
 * Wrap async handler functions with standardized error handling
 */
export function withErrorHandling<T extends (...args: any[]) => Promise<any>>(
  handler: T,
  defaultContext?: ErrorContext
): T {
  return (async (...args: Parameters<T>) => {
    try {
      return await handler(...args);
    } catch (err) {
      throw handleApiError(err, defaultContext);
    }
  }) as T;
}
