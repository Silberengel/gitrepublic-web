/**
 * Simple in-memory cache for repository metadata
 * Reduces redundant filesystem and git operations
 */

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number; // Time to live in milliseconds
}

export class RepoCache {
  private cache: Map<string, CacheEntry<any>> = new Map();
  private defaultTTL: number = 5 * 60 * 1000; // 5 minutes default

  /**
   * Get a value from cache
   */
  get<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) {
      return null;
    }

    // Check if entry has expired
    const now = Date.now();
    if (now - entry.timestamp > entry.ttl) {
      this.cache.delete(key);
      return null;
    }

    return entry.data as T;
  }

  /**
   * Set a value in cache
   */
  set<T>(key: string, data: T, ttl?: number): void {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      ttl: ttl || this.defaultTTL
    });
  }

  /**
   * Delete a value from cache
   */
  delete(key: string): void {
    this.cache.delete(key);
  }

  /**
   * Clear all cache entries
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Clear expired entries
   */
  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > entry.ttl) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Generate cache key for repository existence check
   */
  static repoExistsKey(npub: string, repoName: string): string {
    return `repo:exists:${npub}:${repoName}`;
  }

  /**
   * Generate cache key for branch list
   */
  static branchesKey(npub: string, repoName: string): string {
    return `repo:branches:${npub}:${repoName}`;
  }

  /**
   * Generate cache key for file listing
   */
  static fileListKey(npub: string, repoName: string, ref: string, path: string): string {
    return `repo:files:${npub}:${repoName}:${ref}:${path}`;
  }
}

// Singleton instance
export const repoCache = new RepoCache();

// Cleanup expired entries every 10 minutes
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    repoCache.cleanup();
  }, 10 * 60 * 1000);
}
