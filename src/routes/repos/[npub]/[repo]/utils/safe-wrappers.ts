/**
 * Safe wrapper functions for SSR compatibility
 * These functions check for window availability before executing
 */

/**
 * Safely execute an async function, returning a resolved promise if window is undefined
 */
export function safeAsync<T>(
  fn: () => Promise<T>
): Promise<T | void> {
  if (typeof window === 'undefined') return Promise.resolve();
  try {
    return fn();
  } catch (err) {
    console.warn('Error in safe async function:', err);
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
