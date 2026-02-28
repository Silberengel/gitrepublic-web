/**
 * Safe wrapper functions for SSR compatibility
 * These functions check for window availability before executing
 */

/**
 * Safely execute an async function, returning a resolved promise if window is undefined
 * 
 * This function is designed to:
 * 1. Prevent SSR errors by checking for window availability
 * 2. Catch and log errors without crashing the app
 * 3. Return resolved promises even on error to prevent unhandled rejections
 * 
 * Note: Errors are logged but not re-thrown to prevent unhandled promise rejections
 * in event handlers. The wrapped functions should handle their own errors (e.g., show alerts).
 */
export function safeAsync<T>(
  fn: () => Promise<T>
): Promise<T | void> {
  if (typeof window === 'undefined') return Promise.resolve();
  try {
    return fn().catch((err) => {
      // Log async errors but don't re-throw to prevent unhandled rejections
      // The wrapped functions should handle their own errors (e.g., show alerts)
      console.error('Error in safe async function:', err);
      // Return resolved promise to prevent unhandled rejection
      return Promise.resolve();
    });
  } catch (err) {
    // Synchronous errors - log and return resolved promise to prevent crashes
    console.warn('Synchronous error in safe async function:', err);
    return Promise.resolve();
  }
}

/**
 * Safely execute a sync function, returning void if window is undefined
 */
export function safeSync<T>(
  fn: () => T
): T | void {
  if (typeof window === 'undefined') return;
  try {
    return fn();
  } catch (err) {
    console.warn('Error in safe sync function:', err);
  }
}
