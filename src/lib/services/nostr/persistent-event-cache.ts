/**
 * Persistent event cache using IndexedDB for client-side storage
 * Provides offline access and reduces relay load
 * 
 * Strategy:
 * - Client-side only (IndexedDB) - events are immutable and user-specific
 * - Check cache first, return immediately if available
 * - Fetch from relays in background and merge results
 * - Never delete valid events, only append/integrate new ones
 * - Replaceable events (kind 0, 3, 10002) use latest version per pubkey
 */

import type { NostrEvent, NostrFilter } from '../../types/nostr.js';
import { KIND } from '../../types/nostr.js';
import logger from '../logger.js';
import type { NostrClient } from './nostr-client.js';

const DB_NAME = 'gitrepublic_events';
const DB_VERSION = 1;
const STORE_EVENTS = 'events';
const STORE_FILTERS = 'filters';
const STORE_PROFILES = 'profiles'; // Optimized storage for kind 0 events

// Replaceable event kinds (only latest per pubkey matters)
const REPLACEABLE_KINDS = [0, 3, 10002]; // Profile, Contacts, Relay List

interface CachedEvent {
  event: NostrEvent;
  cachedAt: number;
  filterKey?: string; // Which filter(s) this event matches
}

interface FilterCacheEntry {
  filterKey: string;
  eventIds: string[];
  cachedAt: number;
  ttl: number;
}

/**
 * Generate a deterministic cache key from a filter
 */
function generateFilterKey(filter: NostrFilter): string {
  const sortedFilter = Object.keys(filter)
    .sort()
    .reduce((acc, key) => {
      const value = filter[key as keyof NostrFilter];
      if (value !== undefined) {
        if (Array.isArray(value)) {
          acc[key] = [...value].sort();
        } else {
          acc[key] = value;
        }
      }
      return acc;
    }, {} as Record<string, unknown>);
  
  return JSON.stringify(sortedFilter);
}

/**
 * Generate cache key for multiple filters
 */
function generateMultiFilterKey(filters: NostrFilter[]): string {
  const keys = filters.map(f => generateFilterKey(f)).sort();
  return keys.join('|');
}

/**
 * Check if an event matches a filter
 */
function eventMatchesFilter(event: NostrEvent, filter: NostrFilter): boolean {
  // Check kind
  if (filter.kinds && !filter.kinds.includes(event.kind)) {
    return false;
  }
  
  // Check authors
  if (filter.authors && filter.authors.length > 0) {
    if (!filter.authors.includes(event.pubkey)) {
      return false;
    }
  }
  
  // Check IDs
  if (filter.ids && filter.ids.length > 0) {
    if (!filter.ids.includes(event.id)) {
      return false;
    }
  }
  
  // Check #d tag (for parameterized replaceable events)
  if (filter['#d'] && filter['#d'].length > 0) {
    const dTag = event.tags.find(t => t[0] === 'd')?.[1];
    if (!dTag || !filter['#d'].includes(dTag)) {
      return false;
    }
  }
  
  // Check #a tag (for parameterized replaceable events)
  if (filter['#a'] && filter['#a'].length > 0) {
    const aTag = event.tags.find(t => t[0] === 'a')?.[1];
    if (!aTag || !filter['#a'].includes(aTag)) {
      return false;
    }
  }
  
  // Check #e tag
  if (filter['#e'] && filter['#e'].length > 0) {
    const eTags = event.tags.filter(t => t[0] === 'e').map(t => t[1]);
    if (!eTags.some(e => filter['#e']!.includes(e))) {
      return false;
    }
  }
  
  // Check #p tag
  if (filter['#p'] && filter['#p'].length > 0) {
    const pTags = event.tags.filter(t => t[0] === 'p').map(t => t[1]);
    if (!pTags.some(p => filter['#p']!.includes(p))) {
      return false;
    }
  }
  
  // Check created_at range
  if (filter.since && event.created_at < filter.since) {
    return false;
  }
  if (filter.until && event.created_at > filter.until) {
    return false;
  }
  
  return true;
}

/**
 * Check if an event matches any of the filters
 */
function eventMatchesAnyFilter(event: NostrEvent, filters: NostrFilter[]): boolean {
  return filters.some(filter => eventMatchesFilter(event, filter));
}

export class PersistentEventCache {
  private db: IDBDatabase | null = null;
  private initPromise: Promise<void> | null = null;
  private defaultTTL: number = 5 * 60 * 1000; // 5 minutes
  private profileTTL: number = 30 * 60 * 1000; // 30 minutes for profiles
  private maxCacheAge: number = 7 * 24 * 60 * 60 * 1000; // 7 days max age
  private writeQueue: Array<() => Promise<void>> = [];
  private isProcessingQueue: boolean = false;

  constructor() {
    this.init();
  }

  /**
   * Initialize IndexedDB
   */
  private async init(): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }

    if (typeof window === 'undefined' || !window.indexedDB) {
      logger.warn('IndexedDB not available, using in-memory cache only');
      return;
    }

    this.initPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        logger.error('Failed to open IndexedDB');
        reject(new Error('Failed to open IndexedDB'));
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Events store - stores all events by ID
        if (!db.objectStoreNames.contains(STORE_EVENTS)) {
          const eventStore = db.createObjectStore(STORE_EVENTS, { keyPath: 'id' });
          eventStore.createIndex('pubkey', 'event.pubkey', { unique: false });
          eventStore.createIndex('kind', 'event.kind', { unique: false });
          eventStore.createIndex('created_at', 'event.created_at', { unique: false });
          eventStore.createIndex('cachedAt', 'cachedAt', { unique: false });
        }

        // Filter cache store - maps filter keys to event IDs
        if (!db.objectStoreNames.contains(STORE_FILTERS)) {
          const filterStore = db.createObjectStore(STORE_FILTERS, { keyPath: 'filterKey' });
          filterStore.createIndex('cachedAt', 'cachedAt', { unique: false });
        }

        // Profiles store - optimized for kind 0 events (latest per pubkey)
        if (!db.objectStoreNames.contains(STORE_PROFILES)) {
          db.createObjectStore(STORE_PROFILES, { keyPath: 'pubkey' });
        }
      };
    });

    return this.initPromise;
  }

  /**
   * Get events from cache that match the filters
   */
  async get(filters: NostrFilter[]): Promise<NostrEvent[] | null> {
    await this.init();
    
    if (!this.db) {
      return null;
    }

    try {
      const filterKey = generateMultiFilterKey(filters);
      
      // Check filter cache first
      const filterEntry = await this.getFilterEntry(filterKey);
      if (!filterEntry) {
        return null;
      }

      // Check if filter cache is expired
      const now = Date.now();
      if (now - filterEntry.cachedAt > filterEntry.ttl) {
        // Expired, but we can still return events if they exist
        // Don't delete, just mark as stale
      }

      // Get events from events store
      const events: NostrEvent[] = [];
      const eventStore = this.db.transaction([STORE_EVENTS], 'readonly').objectStore(STORE_EVENTS);
      
      for (const eventId of filterEntry.eventIds) {
        const request = eventStore.get(eventId);
        const cached = await new Promise<CachedEvent | undefined>((resolve) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => resolve(undefined);
        });
        
        if (cached) {
          // Check if event is too old (beyond max cache age)
          if (now - cached.cachedAt < this.maxCacheAge) {
            // Verify event still matches filters (in case filters changed)
            if (eventMatchesAnyFilter(cached.event, filters)) {
              events.push(cached.event);
            }
          }
        }
      }

      // For replaceable events, ensure we only return the latest per pubkey
      const replaceableEvents = new Map<string, NostrEvent>();
      const regularEvents: NostrEvent[] = [];

      for (const event of events) {
        if (REPLACEABLE_KINDS.includes(event.kind)) {
          const existing = replaceableEvents.get(event.pubkey);
          if (!existing || event.created_at > existing.created_at) {
            replaceableEvents.set(event.pubkey, event);
          }
        } else {
          regularEvents.push(event);
        }
      }

      const result = [...Array.from(replaceableEvents.values()), ...regularEvents];
      
      // Sort by created_at descending
      result.sort((a, b) => b.created_at - a.created_at);

      return result.length > 0 ? result : null;
    } catch (error) {
      logger.error({ error, filters }, 'Error reading from event cache');
      return null;
    }
  }

  /**
   * Get filter cache entry
   */
  private async getFilterEntry(filterKey: string): Promise<FilterCacheEntry | null> {
    if (!this.db) return null;

    try {
      const store = this.db.transaction([STORE_FILTERS], 'readonly').objectStore(STORE_FILTERS);
      const request = store.get(filterKey);
      
      return new Promise((resolve) => {
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => resolve(null);
      });
    } catch {
      return null;
    }
  }

  /**
   * Process write queue to prevent concurrent IndexedDB transactions
   */
  private async processWriteQueue(): Promise<void> {
    if (this.isProcessingQueue || this.writeQueue.length === 0) {
      return;
    }

    this.isProcessingQueue = true;

    while (this.writeQueue.length > 0) {
      const writeFn = this.writeQueue.shift();
      if (writeFn) {
        try {
          await writeFn();
        } catch (error) {
          // Log but continue processing queue
          logger.debug({ error }, 'Error in write queue item');
        }
      }
    }

    this.isProcessingQueue = false;
  }

  /**
   * Store events in cache, merging with existing events
   */
  async set(filters: NostrFilter[], events: NostrEvent[], ttl?: number): Promise<void> {
    await this.init();
    
    if (!this.db) {
      return;
    }

    // Queue the write operation to prevent concurrent transactions
    return new Promise<void>((resolve, reject) => {
      let resolved = false;
      
      this.writeQueue.push(async () => {
        try {
          await this._setInternal(filters, events, ttl);
          if (!resolved) {
            resolved = true;
            resolve();
          }
        } catch (error) {
          if (!resolved) {
            resolved = true;
            reject(error);
          }
        }
      });

      // Process queue asynchronously
      this.processWriteQueue().catch(err => {
        if (!resolved) {
          resolved = true;
          reject(err);
        } else {
          logger.debug({ error: err }, 'Error processing write queue');
        }
      });
    });
  }

  /**
   * Internal set method that does the actual work
   */
  private async _setInternal(filters: NostrFilter[], events: NostrEvent[], ttl?: number): Promise<void> {
    if (!this.db) {
      return;
    }

    try {
      const filterKey = generateMultiFilterKey(filters);
      const now = Date.now();
      const cacheTTL = ttl || this.defaultTTL;

      // Determine if this is a profile query
      const isProfileQuery = filters.some(f => 
        f.kinds?.includes(0) && f.authors && f.authors.length > 0
      );

      // Use longer TTL for profile events
      const effectiveTTL = isProfileQuery ? this.profileTTL : cacheTTL;

      // Get existing filter entry (outside transaction)
      const existingEntry = await this.getFilterEntry(filterKey);
      const existingEventIds = new Set(existingEntry?.eventIds || []);

      // Use a single transaction for all operations
      const transaction = this.db.transaction([STORE_EVENTS, STORE_PROFILES, STORE_FILTERS], 'readwrite');
      const eventStore = transaction.objectStore(STORE_EVENTS);
      const profileStore = transaction.objectStore(STORE_PROFILES);
      const filterStore = transaction.objectStore(STORE_FILTERS);

      const newEventIds: string[] = [];

      // Process all events in the transaction
      for (const event of events) {
        // For replaceable events, check if we have a newer version for this pubkey
        if (REPLACEABLE_KINDS.includes(event.kind)) {
          // Check if we already have a newer replaceable event for this pubkey
          const existingProfile = await this.getProfile(event.pubkey);
          if (existingProfile && existingProfile.kind === event.kind && existingProfile.created_at >= event.created_at) {
            // Existing event is newer or same, skip
            if (existingEventIds.has(existingProfile.id)) {
              newEventIds.push(existingProfile.id);
            }
            continue;
          }
        } else {
          // For non-replaceable events, check if we already have this event
          if (existingEventIds.has(event.id)) {
            newEventIds.push(event.id);
            continue;
          }
        }

        // Store the event
        const cached: CachedEvent = {
          event,
          cachedAt: now,
          filterKey
        };

        await new Promise<void>((resolve, reject) => {
          const request = eventStore.put(cached);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        });

        newEventIds.push(event.id);

        // Also store in profiles store if it's a profile event (using same transaction)
        if (event.kind === 0) {
          const existingProfile = await new Promise<CachedEvent | undefined>((resolve) => {
            const req = profileStore.get(event.pubkey);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(undefined);
          });

          if (!existingProfile || event.created_at > existingProfile.event.created_at) {
            await new Promise<void>((resolve, reject) => {
              const req = profileStore.put({ pubkey: event.pubkey, ...cached });
              req.onsuccess = () => resolve();
              req.onerror = () => reject(req.error);
            });
          }
        }
      }

      // Merge with existing event IDs (don't delete valid events)
      const mergedEventIds = Array.from(new Set([...existingEntry?.eventIds || [], ...newEventIds]));

      // Update filter cache entry (using same transaction)
      const filterEntry: FilterCacheEntry = {
        filterKey,
        eventIds: mergedEventIds,
        cachedAt: now,
        ttl: effectiveTTL
      };

      await new Promise<void>((resolve, reject) => {
        const request = filterStore.put(filterEntry);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });

      // Wait for transaction to complete
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });

      logger.debug({ 
        filterKey, 
        eventCount: events.length, 
        mergedCount: mergedEventIds.length,
        ttl: effectiveTTL 
      }, 'Cached events in IndexedDB');
    } catch (error) {
      // Check if it's a quota exceeded error or other recoverable error
      if (error instanceof DOMException) {
        if (error.name === 'QuotaExceededError') {
          logger.warn({ error, filters }, 'IndexedDB quota exceeded, skipping cache write');
          return; // Don't throw, just skip this write
        } else if (error.name === 'TransactionInactiveError' || error.name === 'InvalidStateError') {
          logger.debug({ error, filters }, 'IndexedDB transaction error, likely concurrent write, skipping');
          return; // Don't throw, just skip this write
        }
      }
      logger.error({ error, filters }, 'Error writing to event cache');
      throw error; // Re-throw other errors
    }
  }

  /**
   * Get a single event by ID
   */
  private async getEventById(eventId: string): Promise<NostrEvent | null> {
    if (!this.db) return null;

    try {
      const store = this.db.transaction([STORE_EVENTS], 'readonly').objectStore(STORE_EVENTS);
      const request = store.get(eventId);
      
      return new Promise((resolve) => {
        request.onsuccess = () => {
          const cached = request.result as CachedEvent | undefined;
          resolve(cached?.event || null);
        };
        request.onerror = () => resolve(null);
      });
    } catch {
      return null;
    }
  }

  /**
   * Get profile event (kind 0) for a pubkey
   */
  async getProfile(pubkey: string): Promise<NostrEvent | null> {
    await this.init();
    
    if (!this.db) {
      return null;
    }

    try {
      const store = this.db.transaction([STORE_PROFILES], 'readonly').objectStore(STORE_PROFILES);
      const request = store.get(pubkey);
      
      return new Promise((resolve) => {
        request.onsuccess = () => {
          const cached = request.result as CachedEvent | undefined;
          if (cached) {
            // Check if not too old
            const now = Date.now();
            if (now - cached.cachedAt < this.maxCacheAge) {
              resolve(cached.event);
            } else {
              resolve(null);
            }
          } else {
            resolve(null);
          }
        };
        request.onerror = () => resolve(null);
      });
    } catch (error) {
      logger.error({ error, pubkey }, 'Error reading profile from cache');
      return null;
    }
  }

  /**
   * Set profile event (kind 0)
   */
  async setProfile(pubkey: string, event: NostrEvent): Promise<void> {
    await this.init();
    
    if (!this.db || event.kind !== 0) {
      return;
    }

    try {
      // Check if we have a newer profile
      const existing = await this.getProfile(pubkey);
      if (existing && existing.created_at >= event.created_at) {
        return; // Existing is newer or same
      }

      const cached: CachedEvent = {
        event,
        cachedAt: Date.now()
      };

      const store = this.db.transaction([STORE_PROFILES], 'readwrite').objectStore(STORE_PROFILES);
      await new Promise<void>((resolve, reject) => {
        const request = store.put({ pubkey, ...cached });
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });

      // Also store in events store
      const eventStore = this.db.transaction([STORE_EVENTS], 'readwrite').objectStore(STORE_EVENTS);
      await new Promise<void>((resolve, reject) => {
        const request = eventStore.put(cached);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    } catch (error) {
      logger.error({ error, pubkey }, 'Error writing profile to cache');
    }
  }

  /**
   * Invalidate cache for a specific pubkey
   */
  async invalidatePubkey(pubkey: string): Promise<void> {
    await this.init();
    
    if (!this.db) {
      return;
    }

    try {
      // Remove from profiles store
      const profileStore = this.db.transaction([STORE_PROFILES], 'readwrite').objectStore(STORE_PROFILES);
      await new Promise<void>((resolve, reject) => {
        const request = profileStore.delete(pubkey);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });

      // Remove events from events store
      const eventStore = this.db.transaction([STORE_EVENTS], 'readwrite').objectStore(STORE_EVENTS);
      const index = eventStore.index('pubkey');
      const request = index.openKeyCursor(IDBKeyRange.only(pubkey));
      
      await new Promise<void>((resolve) => {
        request.onsuccess = (event) => {
          const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
          if (cursor) {
            eventStore.delete(cursor.primaryKey);
            cursor.continue();
          } else {
            resolve();
          }
        };
        request.onerror = () => resolve();
      });

      // Invalidate filter entries that reference these events
      const filterStore = this.db.transaction([STORE_FILTERS], 'readwrite').objectStore(STORE_FILTERS);
      const filterRequest = filterStore.openCursor();
      
      await new Promise<void>((resolve) => {
        filterRequest.onsuccess = (event) => {
          const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
          if (cursor) {
            const entry = cursor.value as FilterCacheEntry;
            // Remove event IDs that match this pubkey
            // We'd need to check each event, but for simplicity, just invalidate the filter
            filterStore.delete(cursor.primaryKey);
            cursor.continue();
          } else {
            resolve();
          }
        };
        filterRequest.onerror = () => resolve();
      });
    } catch (error) {
      logger.error({ error, pubkey }, 'Error invalidating pubkey cache');
    }
  }

  /**
   * Invalidate cache for specific filters
   */
  async invalidate(filters: NostrFilter[]): Promise<void> {
    await this.init();
    
    if (!this.db) {
      return;
    }

    try {
      const filterKey = generateMultiFilterKey(filters);
      const store = this.db.transaction([STORE_FILTERS], 'readwrite').objectStore(STORE_FILTERS);
      await new Promise<void>((resolve, reject) => {
        const request = store.delete(filterKey);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    } catch (error) {
      logger.error({ error, filters }, 'Error invalidating filter cache');
    }
  }

  /**
   * Clear all cache
   */
  async clear(): Promise<void> {
    await this.init();
    
    if (!this.db) {
      return;
    }

    try {
      const stores = [STORE_EVENTS, STORE_FILTERS, STORE_PROFILES];
      for (const storeName of stores) {
        const store = this.db.transaction([storeName], 'readwrite').objectStore(storeName);
        await new Promise<void>((resolve, reject) => {
          const request = store.clear();
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        });
      }
      logger.debug('Cleared all event cache');
    } catch (error) {
      logger.error({ error }, 'Error clearing event cache');
    }
  }

  /**
   * Cleanup old entries
   */
  async cleanup(): Promise<void> {
    await this.init();
    
    if (!this.db) {
      return;
    }

    try {
      const now = Date.now();
      let cleaned = 0;

      // Clean up expired filter entries
      const filterStore = this.db.transaction([STORE_FILTERS], 'readwrite').objectStore(STORE_FILTERS);
      const filterRequest = filterStore.openCursor();
      
      await new Promise<void>((resolve) => {
        filterRequest.onsuccess = (event) => {
          const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
          if (cursor) {
            const entry = cursor.value as FilterCacheEntry;
            if (now - entry.cachedAt > entry.ttl) {
              filterStore.delete(cursor.primaryKey);
              cleaned++;
            }
            cursor.continue();
          } else {
            resolve();
          }
        };
        filterRequest.onerror = () => resolve();
      });

      // Clean up old events (beyond max cache age)
      const eventStore = this.db.transaction([STORE_EVENTS], 'readwrite').objectStore(STORE_EVENTS);
      const eventRequest = eventStore.openCursor();
      
      await new Promise<void>((resolve) => {
        eventRequest.onsuccess = (event) => {
          const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
          if (cursor) {
            const cached = cursor.value as CachedEvent;
            if (now - cached.cachedAt > this.maxCacheAge) {
              eventStore.delete(cursor.primaryKey);
              cleaned++;
            }
            cursor.continue();
          } else {
            resolve();
          }
        };
        eventRequest.onerror = () => resolve();
      });

      // Clean up old profiles
      const profileStore = this.db.transaction([STORE_PROFILES], 'readwrite').objectStore(STORE_PROFILES);
      const profileRequest = profileStore.openCursor();
      
      await new Promise<void>((resolve) => {
        profileRequest.onsuccess = (event) => {
          const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
          if (cursor) {
            const cached = cursor.value as CachedEvent;
            if (now - cached.cachedAt > this.maxCacheAge) {
              profileStore.delete(cursor.primaryKey);
              cleaned++;
            }
            cursor.continue();
          } else {
            resolve();
          }
        };
        profileRequest.onerror = () => resolve();
      });

      if (cleaned > 0) {
        logger.debug({ cleaned }, 'Cleaned up old cache entries');
      }
    } catch (error) {
      logger.error({ error }, 'Error during cache cleanup');
    }
  }

  /**
   * Get cache statistics
   */
  async getStats(): Promise<{ events: number; filters: number; profiles: number }> {
    await this.init();
    
    if (!this.db) {
      return { events: 0, filters: 0, profiles: 0 };
    }

    try {
      const eventStore = this.db.transaction([STORE_EVENTS], 'readonly').objectStore(STORE_EVENTS);
      const filterStore = this.db.transaction([STORE_FILTERS], 'readonly').objectStore(STORE_FILTERS);
      const profileStore = this.db.transaction([STORE_PROFILES], 'readonly').objectStore(STORE_PROFILES);

      const [eventCount, filterCount, profileCount] = await Promise.all([
        new Promise<number>((resolve) => {
          const request = eventStore.count();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => resolve(0);
        }),
        new Promise<number>((resolve) => {
          const request = filterStore.count();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => resolve(0);
        }),
        new Promise<number>((resolve) => {
          const request = profileStore.count();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => resolve(0);
        })
      ]);

      return { events: eventCount, filters: filterCount, profiles: profileCount };
    } catch (error) {
      logger.error({ error }, 'Error getting cache stats');
      return { events: 0, filters: 0, profiles: 0 };
    }
  }

  /**
   * Process deletion events (NIP-09) and remove deleted events from cache
   * @param deletionEvents - Array of kind 5 deletion events
   */
  async processDeletionEvents(deletionEvents: NostrEvent[]): Promise<void> {
    await this.init();
    
    if (!this.db || deletionEvents.length === 0) {
      return;
    }

    try {
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

      // Remove events by ID
      if (deletedEventIds.size > 0) {
        const eventStore = this.db.transaction([STORE_EVENTS], 'readwrite').objectStore(STORE_EVENTS);
        
        for (const eventId of deletedEventIds) {
          try {
            await new Promise<void>((resolve, reject) => {
              const request = eventStore.delete(eventId);
              request.onsuccess = () => resolve();
              request.onerror = () => reject(request.error);
            });
            removedCount++;
          } catch {
            // Event might not exist in cache, ignore
          }
        }
      }

      // Remove events by address (parameterized replaceable events)
      if (deletedAddresses.size > 0) {
        const eventStore = this.db.transaction([STORE_EVENTS], 'readwrite').objectStore(STORE_EVENTS);
        const cursorRequest = eventStore.openCursor();
        
        await new Promise<void>((resolve) => {
          cursorRequest.onsuccess = (event) => {
            const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
            if (cursor) {
              const cached = cursor.value as CachedEvent;
              const event = cached.event;
              
              // Check if this event matches any deleted address
              // Format: kind:pubkey:d-tag
              for (const deletedAddr of deletedAddresses) {
                const parts = deletedAddr.split(':');
                if (parts.length === 3) {
                  const [kindStr, pubkey, dTag] = parts;
                  const kind = parseInt(kindStr, 10);
                  
                  if (event.kind === kind && event.pubkey === pubkey) {
                    const eventDTag = event.tags.find(t => t[0] === 'd')?.[1];
                    if (eventDTag === dTag) {
                      // This event matches the deleted address
                      cursor.delete();
                      removedCount++;
                      break;
                    }
                  }
                }
              }
              
              cursor.continue();
            } else {
              resolve();
            }
          };
          cursorRequest.onerror = () => resolve();
        });
      }

      // Remove deleted event IDs from filter cache entries
      if (deletedEventIds.size > 0 || deletedAddresses.size > 0) {
        const filterStore = this.db.transaction([STORE_FILTERS], 'readwrite').objectStore(STORE_FILTERS);
        const filterRequest = filterStore.openCursor();
        
        await new Promise<void>((resolve) => {
          filterRequest.onsuccess = (event) => {
            const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
            if (cursor) {
              const entry = cursor.value as FilterCacheEntry;
              const originalLength = entry.eventIds.length;
              
              // Remove deleted event IDs
              entry.eventIds = entry.eventIds.filter(id => !deletedEventIds.has(id));
              
              // If we removed any IDs, update the entry
              if (entry.eventIds.length !== originalLength) {
                cursor.update(entry);
              }
              
              cursor.continue();
            } else {
              resolve();
            }
          };
          filterRequest.onerror = () => resolve();
        });
      }

      // Also remove from profiles store if applicable
      if (deletedEventIds.size > 0) {
        const profileStore = this.db.transaction([STORE_PROFILES], 'readwrite').objectStore(STORE_PROFILES);
        const profileRequest = profileStore.openCursor();
        
        await new Promise<void>((resolve) => {
          profileRequest.onsuccess = (event) => {
            const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
            if (cursor) {
              const cached = cursor.value as CachedEvent;
              if (deletedEventIds.has(cached.event.id)) {
                cursor.delete();
                removedCount++;
              }
              cursor.continue();
            } else {
              resolve();
            }
          };
          profileRequest.onerror = () => resolve();
        });
      }

      if (removedCount > 0) {
        logger.debug({ removedCount, deletedEventIds: deletedEventIds.size, deletedAddresses: deletedAddresses.size }, 'Processed deletion events and removed from cache');
      }
    } catch (error) {
      logger.error({ error, deletionEvents: deletionEvents.length }, 'Error processing deletion events');
    }
  }

  /**
   * Fetch deletion events from relays and process them
   * @param nostrClient - NostrClient instance to fetch events
   * @param userPubkeys - Array of user pubkeys to fetch deletions for (optional)
   */
  async fetchAndProcessDeletions(nostrClient: NostrClient, userPubkeys: string[] = []): Promise<void> {
    try {
      // Fetch deletion events (kind 5) for the specified users
      const filters: NostrFilter[] = [];
      
      if (userPubkeys.length > 0) {
        // Fetch deletions for specific users
        filters.push({
          kinds: [KIND.DELETION_REQUEST],
          authors: userPubkeys,
          limit: 100
        });
      } else {
        // If no specific users, we can't fetch all deletions (would be too many)
        // In this case, we'll just process any deletions that are already in cache
        // or skip this call
        logger.debug('No user pubkeys provided, skipping deletion fetch');
        return;
      }

      const deletionEvents = await nostrClient.fetchEvents(filters);
      
      if (deletionEvents.length > 0) {
        await this.processDeletionEvents(deletionEvents);
      }
    } catch (error) {
      logger.error({ error, userPubkeys: userPubkeys.length }, 'Error fetching and processing deletion events');
      throw error;
    }
  }
}

// Singleton instance
export const persistentEventCache = new PersistentEventCache();

// Run cleanup every hour and process deletions every 15 minutes
if (typeof window !== 'undefined') {
  setInterval(() => {
    persistentEventCache.cleanup().catch(err => {
      logger.error({ error: err }, 'Error during scheduled cache cleanup');
    });
  }, 60 * 60 * 1000); // 1 hour

  // Process deletion events in the background every 15 minutes
  // This will be triggered when a NostrClient is available
  let deletionProcessingInterval: ReturnType<typeof setInterval> | null = null;
  
  // Start deletion processing when a client becomes available
  // We'll set this up in the NostrClient or a service that has access to it
  (window as any).__startDeletionProcessing = async (nostrClient: any, userPubkeys: string[] = []) => {
    if (deletionProcessingInterval) {
      clearInterval(deletionProcessingInterval);
    }
    
    // Process immediately, then every 15 minutes
    persistentEventCache.fetchAndProcessDeletions(nostrClient, userPubkeys).catch((err: unknown) => {
      logger.debug({ error: err }, 'Error during initial deletion processing');
    });
    
    deletionProcessingInterval = setInterval(() => {
      persistentEventCache.fetchAndProcessDeletions(nostrClient, userPubkeys).catch((err: unknown) => {
        logger.debug({ error: err }, 'Error during scheduled deletion processing');
      });
    }, 15 * 60 * 1000); // 15 minutes
  };
}
