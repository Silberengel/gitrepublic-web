/**
 * Activity tracker for user sessions
 * Tracks ONLY the last activity timestamp (no information about what the user did)
 * Used for 24-hour auto-logout after inactivity
 * 
 * SECURITY: Only stores a single timestamp value. No activity details are stored.
 */

const LAST_ACTIVITY_KEY = 'gitrepublic_last_activity';
const SESSION_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

/**
 * Update the last activity timestamp
 * 
 * SECURITY: Only stores the timestamp (Date.now()). No information about
 * what the user did is stored. Previous timestamp is overwritten.
 */
export function updateActivity(): void {
  if (typeof window === 'undefined') return;
  
  // Only store the timestamp - no activity details
  const now = Date.now();
  localStorage.setItem(LAST_ACTIVITY_KEY, now.toString());
}

/**
 * Get the last activity timestamp
 */
export function getLastActivity(): number | null {
  if (typeof window === 'undefined') return null;
  
  const timestamp = localStorage.getItem(LAST_ACTIVITY_KEY);
  return timestamp ? parseInt(timestamp, 10) : null;
}

/**
 * Check if the session has expired (24 hours since last activity)
 */
export function isSessionExpired(): boolean {
  if (typeof window === 'undefined') return false;
  
  const lastActivity = getLastActivity();
  if (!lastActivity) return false;
  
  const now = Date.now();
  const timeSinceActivity = now - lastActivity;
  
  return timeSinceActivity >= SESSION_TIMEOUT_MS;
}

/**
 * Clear activity tracking (on logout)
 */
export function clearActivity(): void {
  if (typeof window === 'undefined') return;
  
  localStorage.removeItem(LAST_ACTIVITY_KEY);
}

/**
 * Get time until session expires (in milliseconds)
 * Returns 0 if expired or no activity
 */
export function getTimeUntilExpiry(): number {
  if (typeof window === 'undefined') return 0;
  
  const lastActivity = getLastActivity();
  if (!lastActivity) return 0;
  
  const now = Date.now();
  const timeSinceActivity = now - lastActivity;
  const timeUntilExpiry = SESSION_TIMEOUT_MS - timeSinceActivity;
  
  return Math.max(0, timeUntilExpiry);
}
