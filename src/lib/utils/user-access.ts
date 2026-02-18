/**
 * Utility functions for checking user access levels
 */

import type { UserLevel } from '../services/nostr/user-level-service.js';

/**
 * Check if a user has unlimited/write access
 * Only unlimited users can clone repos and register new repos
 */
export function hasUnlimitedAccess(userLevel: UserLevel | null | undefined): boolean {
  return userLevel === 'unlimited';
}

/**
 * Check if a user is logged in (has any access level)
 */
export function isLoggedIn(userLevel: UserLevel | null | undefined): boolean {
  return userLevel !== null && userLevel !== undefined && userLevel !== 'strictly_rate_limited';
}
