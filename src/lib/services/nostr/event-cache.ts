/**
 * Cache for Nostr events to provide offline access
 * Stores events with TTL to reduce relay load and improve resilience
 */

import type { NostrEvent, NostrFilter } from '../../types/nostr.js';
import { createHash } from 'crypto';
import logger from '../logger.js';

interface CacheEntry {
  events: NostrEvent[];
  timestamp: number;
  ttl: number; // Time to live in milliseconds
}

/**
 * Generate cache key from filter
 * Creates a deterministic key based on filter parameters
 */
function generateCacheKey(filter: NostrFilter): string {
  // Sort filter keys for consistency
  const sortedFilter = Object.keys(filter)
    .sort()
    .reduce((acc, key) => {
      const value = filter[key as keyof NostrFilter];
      if (value !== undefined) {
        // Sort array values for consistency
        if (Array.isArray(value)) {
          acc[key] = [...value].sort();
        } else {
          acc[key] = value;
        }
      }
      return acc;
    }, {} as Record<string, unknown>);
  
  const filterStr = JSON.stringify(sortedFilter);
  return createHash('sha256').update(filterStr).digest('hex');
}

/**
 * Generate cache key for multiple filters
 */
function generateMultiFilterCacheKey(filters: NostrFilter[]): string {
  const keys = filters.map(f => generateCacheKey(f)).sort();
  return createHash('sha256').update(keys.join('|')).digest('hex');
}

export class EventCache {
  private cache: Map<string, CacheEntry> = new Map();
  private defaultTTL: number = 5 * 60 * 1000; // 5 minutes default
  private maxCacheSize: number = 10000; // Maximum number of cache entries

  constructor(defaultTTL?: number, maxCacheSize?: number) {
    if (defaultTTL) {
      this.defaultTTL = defaultTTL;
    }
    if (maxCacheSize) {
      this.maxCacheSize = maxCacheSize;
    }
    
    // Cleanup expired entries every 5 minutes
    if (typeof setInterval !== 'undefined') {
      setInterval(() => {
        this.cleanup();
      }, 5 * 60 * 1000);
    }
  }

  /**
   * Get cached events for a filter
   */
  get(filters: NostrFilter[]): NostrEvent[] | null {
    const key = generateMultiFilterCacheKey(filters);
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

    // Filter events to match the current filter (in case filter changed slightly)
    // For now, we return all cached events - the caller should filter if needed
    return entry.events;
  }

  /**
   * Set cached events for filters
   */
  set(filters: NostrFilter[], events: NostrEvent[], ttl?: number): void {
    // Prevent cache from growing too large
    if (this.cache.size >= this.maxCacheSize) {
      this.evictOldest();
    }

    const key = generateMultiFilterCacheKey(filters);
    this.cache.set(key, {
      events,
      timestamp: Date.now(),
      ttl: ttl || this.defaultTTL
    });
  }

  /**
   * Invalidate cache entries matching a filter pattern
   * Useful when events are published/updated
   */
  invalidate(filters: NostrFilter[]): void {
    const key = generateMultiFilterCacheKey(filters);
    this.cache.delete(key);
  }

  /**
   * Invalidate all cache entries for a specific event ID
   * Useful when an event is updated
   */
  invalidateEvent(eventId: string): void {
    // Find all cache entries containing this event
    for (const [key, entry] of this.cache.entries()) {
      if (entry.events.some(e => e.id === eventId)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Invalidate all cache entries for a specific pubkey
   * Useful when a user's events are updated
   */
  invalidatePubkey(pubkey: string): void {
    // Find all cache entries containing events from this pubkey
    for (const [key, entry] of this.cache.entries()) {
      if (entry.events.some(e => e.pubkey === pubkey)) {
        this.cache.delete(key);
      }
    }
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
    let cleaned = 0;
    
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > entry.ttl) {
        this.cache.delete(key);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      logger.debug({ cleaned, remaining: this.cache.size }, 'Event cache cleanup');
    }
  }

  /**
   * Evict oldest entries when cache is full
   */
  private evictOldest(): void {
    // Sort entries by timestamp (oldest first)
    const entries = Array.from(this.cache.entries())
      .map(([key, entry]) => ({ key, timestamp: entry.timestamp }))
      .sort((a, b) => a.timestamp - b.timestamp);
    
    // Remove oldest 10% of entries
    const toRemove = Math.max(1, Math.floor(entries.length * 0.1));
    for (let i = 0; i < toRemove; i++) {
      this.cache.delete(entries[i].key);
    }
    
    logger.debug({ removed: toRemove, remaining: this.cache.size }, 'Event cache eviction');
  }

  /**
   * Get cache statistics
   */
  getStats(): { size: number; maxSize: number; entries: number } {
    return {
      size: this.cache.size,
      maxSize: this.maxCacheSize,
      entries: Array.from(this.cache.values()).reduce((sum, entry) => sum + entry.events.length, 0)
    };
  }
}

// Singleton instance
export const eventCache = new EventCache(
  5 * 60 * 1000, // 5 minutes default TTL
  10000 // Max 10k cache entries
);
