/**
 * Cache for user access levels
 * Prevents users from losing access when relays are temporarily down
 * 
 * SECURITY:
 * - Only caches successful verifications. Failed verifications are not cached.
 * - Cache is keyed by pubkey, so only the user with that pubkey can use it
 * - Users must still provide a valid proof event signed with their private key
 * - Cache expires after 24 hours, requiring re-verification
 * - If relays are down and no cache exists, access is denied (security-first)
 */

interface CachedUserLevel {
  level: 'unlimited' | 'rate_limited';
  userPubkeyHex: string;
  cachedAt: number;
  expiresAt: number;
}

// In-memory cache (in production, consider Redis for distributed systems)
const userLevelCache = new Map<string, CachedUserLevel>();

// Cache duration: 24 hours (users keep access even if relays are down)
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000;

// Cleanup interval: remove expired entries every hour
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

let cleanupInterval: NodeJS.Timeout | null = null;

/**
 * Start cleanup interval if not already running
 */
function startCleanup(): void {
  if (cleanupInterval) return;
  
  cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of userLevelCache.entries()) {
      if (entry.expiresAt < now) {
        userLevelCache.delete(key);
      }
    }
  }, CLEANUP_INTERVAL_MS);
}

/**
 * Get cached user level if it exists and is still valid
 */
export function getCachedUserLevel(userPubkeyHex: string): CachedUserLevel | null {
  startCleanup();
  
  const cached = userLevelCache.get(userPubkeyHex);
  if (!cached) {
    return null;
  }
  
  // Check if cache is still valid
  const now = Date.now();
  if (cached.expiresAt < now) {
    userLevelCache.delete(userPubkeyHex);
    return null;
  }
  
  return cached;
}

/**
 * Cache a successful user level verification
 * Only caches successful verifications (unlimited or rate_limited)
 * Does not cache failures (strictly_rate_limited)
 */
export function cacheUserLevel(
  userPubkeyHex: string,
  level: 'unlimited' | 'rate_limited'
): void {
  startCleanup();
  
  const now = Date.now();
  const cached: CachedUserLevel = {
    level,
    userPubkeyHex,
    cachedAt: now,
    expiresAt: now + CACHE_DURATION_MS
  };
  
  userLevelCache.set(userPubkeyHex, cached);
}

/**
 * Clear cached user level (e.g., on logout or when access is revoked)
 */
export function clearCachedUserLevel(userPubkeyHex: string): void {
  userLevelCache.delete(userPubkeyHex);
}

/**
 * Get cache statistics (for monitoring)
 */
export function getCacheStats(): {
  size: number;
  entries: Array<{ userPubkeyHex: string; level: string; expiresAt: number }>;
} {
  const entries = Array.from(userLevelCache.entries()).map(([key, value]) => ({
    userPubkeyHex: key,
    level: value.level,
    expiresAt: value.expiresAt
  }));
  
  return {
    size: userLevelCache.size,
    entries
  };
}

/**
 * Clear all cached entries (useful for testing or manual resets)
 */
export function clearAllCache(): void {
  userLevelCache.clear();
}
