/**
 * Cache for Nostr events to provide offline access
 * Stores events with TTL to reduce relay load and improve resilience
 */

import type { NostrEvent, NostrFilter } from '../../types/nostr.js';
import { KIND } from '../../types/nostr.js';
// Lazy import logger to avoid initialization order issues
import type { Logger } from '../../types/logger.js';

let loggerCache: Logger | null = null;
let loggerPromise: Promise<Logger> | null = null;

const getLogger = async (): Promise<Logger> => {
  if (loggerCache) {
    return loggerCache;
  }
  
  if (!loggerPromise) {
    loggerPromise = import('../logger.js').then(module => {
      loggerCache = module.default;
      return loggerCache!;
    }).catch(err => {
      // Fallback to console logger if import fails
      loggerCache = {
        info: (...args: unknown[]) => console.log('[INFO]', ...args),
        error: (...args: unknown[]) => console.error('[ERROR]', ...args),
        warn: (...args: unknown[]) => console.warn('[WARN]', ...args),
        debug: (...args: unknown[]) => console.debug('[DEBUG]', ...args),
        trace: (...args: unknown[]) => console.trace('[TRACE]', ...args),
        fatal: (...args: unknown[]) => console.error('[FATAL]', ...args)
      } as Logger;
      return loggerCache!;
    });
  }
  
  return loggerPromise;
};

interface CacheEntry {
  events: NostrEvent[];
  timestamp: number;
  ttl: number; // Time to live in milliseconds
}

/**
 * Synchronous hash using a simple approach for cache keys
 * Since we need synchronous hashing for cache keys, we'll use a simpler approach
 * This is sufficient for cache key generation (doesn't need to be cryptographically secure)
 */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  // Convert to positive hex string
  return Math.abs(hash).toString(16).padStart(8, '0');
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
  // Use simple hash for synchronous cache key generation
  return simpleHash(filterStr);
}

/**
 * Generate cache key for multiple filters
 */
function generateMultiFilterCacheKey(filters: NostrFilter[]): string {
  const keys = filters.map(f => generateCacheKey(f)).sort();
  return simpleHash(keys.join('|'));
}

export class EventCache {
  private cache: Map<string, CacheEntry> = new Map();
  private defaultTTL: number = 5 * 60 * 1000; // 5 minutes default
  private maxCacheSize: number = 10000; // Maximum number of cache entries
  // Special TTL for kind 0 (profile) events - longer since profiles don't change often
  private profileEventTTL: number = 30 * 60 * 1000; // 30 minutes for profile events

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

    // Check if this is a kind 0 (profile) event query
    const isProfileQuery = filters.some(f => 
      f.kinds && f.kinds.includes(0) && f.authors && f.authors.length > 0
    );

    // For kind 0 events, use longer TTL and ensure we only cache the latest per pubkey
    let processedEvents = events;
    if (isProfileQuery) {
      // For replaceable events (kind 0), only keep the latest event per pubkey
      const latestByPubkey = new Map<string, NostrEvent>();
      for (const event of events) {
        const existing = latestByPubkey.get(event.pubkey);
        if (!existing || event.created_at > existing.created_at) {
          latestByPubkey.set(event.pubkey, event);
        }
      }
      processedEvents = Array.from(latestByPubkey.values());
      
      // Use longer TTL for profile events
      if (!ttl) {
        ttl = this.profileEventTTL;
      }
    }

    const key = generateMultiFilterCacheKey(filters);
    this.cache.set(key, {
      events: processedEvents,
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
   * Get the latest kind 0 (profile) event for a specific pubkey
   * This is optimized for profile lookups
   */
  getProfile(pubkey: string): NostrEvent | null {
    const filters: NostrFilter[] = [
      {
        kinds: [0],
        authors: [pubkey],
        limit: 1
      }
    ];
    
    const cached = this.get(filters);
    if (cached && cached.length > 0) {
      // Return the most recent profile event
      return cached.sort((a, b) => b.created_at - a.created_at)[0];
    }
    
    return null;
  }

  /**
   * Cache a profile event (kind 0) for a specific pubkey
   */
  setProfile(pubkey: string, event: NostrEvent): void {
    const filters: NostrFilter[] = [
      {
        kinds: [0],
        authors: [pubkey],
        limit: 1
      }
    ];
    
    // Check if we already have a cached profile for this pubkey
    const existing = this.getProfile(pubkey);
    if (existing && existing.created_at >= event.created_at) {
      // Existing profile is newer or same, don't overwrite
      return;
    }
    
    // Cache the new profile event
    this.set(filters, [event], this.profileEventTTL);
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
      getLogger().then(logger => {
        logger.debug({ cleaned, remaining: this.cache.size }, 'Event cache cleanup');
      }).catch(() => {
        // Ignore logger errors
      });
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
    
    getLogger().then(logger => {
      logger.debug({ removed: toRemove, remaining: this.cache.size }, 'Event cache eviction');
    }).catch(() => {
      // Ignore logger errors
    });
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

  /**
   * Process deletion events (NIP-09) and remove deleted events from cache
   * @param deletionEvents - Array of kind 5 deletion events
   */
  processDeletionEvents(deletionEvents: NostrEvent[]): void {
    if (deletionEvents.length === 0) {
      return;
    }

    const deletedEventIds = new Set<string>();
    const deletedAddresses = new Set<string>(); // Format: kind:pubkey:d-tag

    // Extract deleted event IDs and addresses from deletion events
    for (const deletionEvent of deletionEvents) {
      if (deletionEvent.kind !== KIND.DELETION_REQUEST) {
        continue;
      }

      // Extract 'e' tags (deleted event IDs)
      for (const tag of deletionEvent.tags) {
        if (tag[0] === 'e' && tag[1]) {
          deletedEventIds.add(tag[1]);
        }
        // Extract 'a' tags (deleted parameterized replaceable events)
        if (tag[0] === 'a' && tag[1]) {
          deletedAddresses.add(tag[1]);
        }
      }
    }

    if (deletedEventIds.size === 0 && deletedAddresses.size === 0) {
      return; // No deletions to process
    }

    let removedCount = 0;

    // Remove events from all cache entries
    for (const [key, entry] of this.cache.entries()) {
      const originalLength = entry.events.length;
      
      // Filter out deleted events
      entry.events = entry.events.filter(event => {
        // Check if event ID is deleted
        if (deletedEventIds.has(event.id)) {
          removedCount++;
          return false;
        }
        
        // Check if event matches a deleted address (parameterized replaceable)
        for (const deletedAddr of deletedAddresses) {
          const parts = deletedAddr.split(':');
          if (parts.length === 3) {
            const [kindStr, pubkey, dTag] = parts;
            const kind = parseInt(kindStr, 10);
            
            if (event.kind === kind && event.pubkey === pubkey) {
              const eventDTag = event.tags.find(t => t[0] === 'd')?.[1];
              if (eventDTag === dTag) {
                removedCount++;
                return false;
              }
            }
          }
        }
        
        return true;
      });

      // If all events were removed, remove the cache entry
      if (entry.events.length === 0) {
        this.cache.delete(key);
      } else if (entry.events.length !== originalLength) {
        // Update timestamp since we modified the entry
        entry.timestamp = Date.now();
      }
    }

    if (removedCount > 0) {
      getLogger().then(logger => {
        logger.debug({ removedCount, deletedEventIds: deletedEventIds.size, deletedAddresses: deletedAddresses.size }, 'Processed deletion events and removed from in-memory cache');
      }).catch(() => {
        // Ignore logger errors
      });
    }
  }
}

// Singleton instance
export const eventCache = new EventCache(
  5 * 60 * 1000, // 5 minutes default TTL
  10000 // Max 10k cache entries
);
