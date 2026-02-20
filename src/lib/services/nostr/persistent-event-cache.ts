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

/**
 * Check if an event is a parameterized replaceable event (NIP-33)
 * Parameterized replaceable events have kind >= 10000 && kind < 20000 and a 'd' tag
 */
function isParameterizedReplaceable(event: NostrEvent): boolean {
  return event.kind >= 10000 && event.kind < 20000 && 
         event.tags.some(t => t[0] === 'd' && t[1]);
}

/**
 * Get the deduplication key for an event
 * For replaceable events: kind:pubkey
 * For parameterized replaceable events: kind:pubkey:d-tag
 * For regular events: event.id
 */
function getDeduplicationKey(event: NostrEvent): string {
  if (REPLACEABLE_KINDS.includes(event.kind)) {
    return `${event.kind}:${event.pubkey}`;
  }
  if (isParameterizedReplaceable(event)) {
    const dTag = event.tags.find(t => t[0] === 'd')?.[1] || '';
    return `${event.kind}:${event.pubkey}:${dTag}`;
  }
  return event.id;
}

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

interface InMemoryCacheEntry {
  events: NostrEvent[];
  timestamp: number;
  ttl: number;
}

export class PersistentEventCache {
  private db: IDBDatabase | null = null;
  private initPromise: Promise<void> | null = null;
  private defaultTTL: number = 5 * 60 * 1000; // 5 minutes
  private profileTTL: number = 30 * 60 * 1000; // 30 minutes for profiles
  private maxCacheAge: number = 7 * 24 * 60 * 60 * 1000; // 7 days max age
  private writeQueue: Array<() => Promise<void>> = [];
  private isProcessingQueue: boolean = false;
  private queueProcessingPromise: Promise<void> | null = null;
  
  // In-memory read-through cache for fast synchronous access
  // This eliminates the need for a separate in-memory cache
  private memoryCache: Map<string, InMemoryCacheEntry> = new Map();
  private maxMemoryCacheSize: number = 1000; // Limit memory cache size

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
      logger.debug('IndexedDB not available, using in-memory cache only');
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
   * Uses in-memory read-through cache for fast synchronous access
   */
  async get(filters: NostrFilter[]): Promise<NostrEvent[] | null> {
    const filterKey = generateMultiFilterKey(filters);
    const now = Date.now();
    
    // 1. Check in-memory cache first (synchronous, fast)
    const memoryEntry = this.memoryCache.get(filterKey);
    if (memoryEntry) {
      const age = now - memoryEntry.timestamp;
      if (age < memoryEntry.ttl) {
        // Cache hit - return immediately
        return memoryEntry.events;
      }
      // Expired in memory, but might still be in IndexedDB - continue to check
    }
    
    // 2. Check IndexedDB (async, slower but persistent)
    await this.init();
    
    if (!this.db) {
      return null;
    }

    try {
      // Check filter cache first
      const filterEntry = await this.getFilterEntry(filterKey);
      if (!filterEntry) {
        return null;
      }

      // Check if filter cache is expired
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

      // For replaceable and parameterized replaceable events, ensure we only return the latest per deduplication key
      const deduplicatedEvents = new Map<string, NostrEvent>(); // deduplication key -> latest event

      for (const event of events) {
        const key = getDeduplicationKey(event);
        const existing = deduplicatedEvents.get(key);
        if (!existing || event.created_at > existing.created_at) {
          deduplicatedEvents.set(key, event);
        }
      }

      const result = Array.from(deduplicatedEvents.values());
      
      // Sort by created_at descending
      result.sort((a, b) => b.created_at - a.created_at);

      // Update in-memory cache with result from IndexedDB
      if (result.length > 0) {
        const ttl = filterEntry.ttl;
        this.updateMemoryCache(filterKey, result, ttl);
        return result;
      }

      return null;
    } catch (error) {
      logger.error({ error, filters }, 'Error reading from event cache');
      return null;
    }
  }
  
  /**
   * Update in-memory cache and enforce size limit
   */
  private updateMemoryCache(filterKey: string, events: NostrEvent[], ttl: number): void {
    // Enforce size limit - remove oldest entries if needed
    if (this.memoryCache.size >= this.maxMemoryCacheSize) {
      // Remove oldest entry (simple FIFO - could be improved with LRU)
      const firstKey = this.memoryCache.keys().next().value;
      if (firstKey) {
        this.memoryCache.delete(firstKey);
      }
    }
    
    this.memoryCache.set(filterKey, {
      events,
      timestamp: Date.now(),
      ttl
    });
  }
  
  /**
   * Get events synchronously from in-memory cache only (for fast access)
   * Returns null if not in memory cache - use async get() for full cache access
   */
  getSync(filters: NostrFilter[]): NostrEvent[] | null {
    const filterKey = generateMultiFilterKey(filters);
    const memoryEntry = this.memoryCache.get(filterKey);
    
    if (!memoryEntry) {
      return null;
    }
    
    const now = Date.now();
    const age = now - memoryEntry.timestamp;
    
    if (age < memoryEntry.ttl) {
      return memoryEntry.events;
    }
    
    // Expired
    this.memoryCache.delete(filterKey);
    return null;
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
   * Ensures only one processor runs at a time by tracking a promise
   */
  private async processWriteQueue(): Promise<void> {
    // If already processing, wait for the current processor to finish
    if (this.queueProcessingPromise) {
      return this.queueProcessingPromise;
    }

    // If queue is empty, nothing to do
    if (this.writeQueue.length === 0) {
      return;
    }

    // Create a promise that processes the queue
    this.queueProcessingPromise = (async () => {
      this.isProcessingQueue = true;

      try {
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
      } finally {
        this.isProcessingQueue = false;
        this.queueProcessingPromise = null;
      }
    })();

    return this.queueProcessingPromise;
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

      // Process queue asynchronously (don't await, but track the promise)
      // Multiple calls will share the same processing promise
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

      // Quick check: if all events already exist and TTL hasn't expired, skip the write
      const allEventsExist = events.length > 0 && events.every(e => existingEventIds.has(e.id));
      if (allEventsExist && existingEntry) {
        const now = Date.now();
        const age = now - existingEntry.cachedAt;
        // If cache is still fresh (within 80% of TTL), skip the write
        if (age < (existingEntry.ttl * 0.8)) {
          logger.debug({ filterKey, eventCount: events.length }, 'All events already cached and fresh, skipping write');
          return;
        }
      }

      // Use a single transaction for all operations
      const transaction = this.db.transaction([STORE_EVENTS, STORE_PROFILES, STORE_FILTERS], 'readwrite');
      const eventStore = transaction.objectStore(STORE_EVENTS);
      const profileStore = transaction.objectStore(STORE_PROFILES);
      const filterStore = transaction.objectStore(STORE_FILTERS);

      let newEventIds: string[] = [];
      const eventsToDelete = new Set<string>();

      // Group events by deduplication key to find the newest per key
      const eventsByKey = new Map<string, NostrEvent>();
      for (const event of events) {
        const key = getDeduplicationKey(event);
        const existing = eventsByKey.get(key);
        if (!existing || event.created_at > existing.created_at) {
          if (existing) {
            eventsToDelete.add(existing.id); // Mark older version for deletion
          }
          eventsByKey.set(key, event);
        } else {
          eventsToDelete.add(event.id); // This one is older
        }
      }

      // Check existing events in cache for same deduplication keys and mark older ones for deletion
      for (const eventId of existingEventIds) {
        const existingEventRequest = eventStore.get(eventId);
        const existingCached = await new Promise<CachedEvent | undefined>((resolve) => {
          existingEventRequest.onsuccess = () => resolve(existingEventRequest.result);
          existingEventRequest.onerror = () => resolve(undefined);
        });
        
        if (existingCached) {
          const existingEvent = existingCached.event;
          const key = getDeduplicationKey(existingEvent);
          const newEvent = eventsByKey.get(key);
          
          // If we have a newer event with the same key, mark the old one for deletion
          if (newEvent && newEvent.id !== existingEvent.id && newEvent.created_at > existingEvent.created_at) {
            eventsToDelete.add(existingEvent.id);
          }
        }
      }

      // Process all events in the transaction (only the newest per deduplication key)
      for (const event of Array.from(eventsByKey.values())) {
        const key = getDeduplicationKey(event);
        
        // For replaceable events (kind 0, 3, 10002), check profile store (only kind 0 uses it, but check all)
        if (REPLACEABLE_KINDS.includes(event.kind)) {
          // For kind 0, check profile store
          if (event.kind === 0) {
            const existingProfile = await new Promise<CachedEvent | undefined>((resolve) => {
              const req = profileStore.get(event.pubkey);
              req.onsuccess = () => resolve(req.result);
              req.onerror = () => resolve(undefined);
            });
            
            if (existingProfile && existingProfile.event.kind === event.kind && existingProfile.event.created_at >= event.created_at) {
              // Existing event is newer or same, skip
              if (existingEventIds.has(existingProfile.event.id)) {
                newEventIds.push(existingProfile.event.id);
              }
              // Mark this one for deletion if it's different
              if (existingProfile.event.id !== event.id) {
                eventsToDelete.add(event.id);
              }
              continue;
            }
          } else {
            // For kind 3 and 10002, check if we already have a newer one in events store
            // We already checked above, so just continue if it's already in existingEventIds
            if (existingEventIds.has(event.id)) {
              newEventIds.push(event.id);
              continue;
            }
          }
        } else if (isParameterizedReplaceable(event)) {
          // For parameterized replaceable events, check if we already have this event
          if (existingEventIds.has(event.id)) {
            newEventIds.push(event.id);
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

        try {
          await new Promise<void>((resolve, reject) => {
            const request = eventStore.put(cached);
            request.onsuccess = () => resolve();
            request.onerror = () => {
              const err = request.error;
              // Handle transaction errors gracefully
              if (err instanceof DOMException && 
                  (err.name === 'TransactionInactiveError' || err.name === 'InvalidStateError')) {
                logger.debug({ error: err }, 'IndexedDB request error, transaction inactive');
                resolve(); // Don't reject, just skip this write
                return;
              }
              reject(err);
            };
          });
        } catch (err) {
          // If it's a transaction error, skip this event and continue
          if (err instanceof DOMException && 
              (err.name === 'TransactionInactiveError' || err.name === 'InvalidStateError')) {
            logger.debug({ error: err }, 'IndexedDB transaction error during event store, skipping');
            continue; // Skip this event
          }
          throw err; // Re-throw other errors
        }

        newEventIds.push(event.id);

        // Also store in profiles store if it's a profile event (using same transaction)
        if (event.kind === 0) {
          const existingProfile = await new Promise<CachedEvent | undefined>((resolve) => {
            const req = profileStore.get(event.pubkey);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(undefined);
          });

          if (!existingProfile || event.created_at > existingProfile.event.created_at) {
            try {
              await new Promise<void>((resolve, reject) => {
                const req = profileStore.put({ pubkey: event.pubkey, ...cached });
                req.onsuccess = () => resolve();
                req.onerror = () => {
                  const err = req.error;
                  // Handle transaction errors gracefully
                  if (err instanceof DOMException && 
                      (err.name === 'TransactionInactiveError' || err.name === 'InvalidStateError')) {
                    logger.debug({ error: err }, 'IndexedDB request error in profile store, transaction inactive');
                    resolve(); // Don't reject, just skip this write
                    return;
                  }
                  reject(err);
                };
              });
            } catch (err) {
              // If it's a transaction error, skip this profile update and continue
              if (err instanceof DOMException && 
                  (err.name === 'TransactionInactiveError' || err.name === 'InvalidStateError')) {
                logger.debug({ error: err }, 'IndexedDB transaction error during profile store, skipping');
                // Continue processing other events
              } else {
                throw err; // Re-throw other errors
              }
            }
          }
        }
      }

      // Delete older events that have been superseded
      for (const eventId of eventsToDelete) {
        try {
          await new Promise<void>((resolve, reject) => {
            const req = eventStore.delete(eventId);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
          });
          // Remove from existing event IDs if present
          existingEventIds.delete(eventId);
          newEventIds = newEventIds.filter(id => id !== eventId);
          
          // Also remove from profile store if it's a kind 0 event
          const deleteProfileRequest = profileStore.openCursor();
          await new Promise<void>((resolve) => {
            deleteProfileRequest.onsuccess = (event) => {
              const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
              if (cursor) {
                const cached = cursor.value as CachedEvent;
                if (cached.event.id === eventId) {
                  cursor.delete();
                }
                cursor.continue();
              } else {
                resolve();
              }
            };
            deleteProfileRequest.onerror = () => resolve();
          });
        } catch (error) {
          logger.debug({ error, eventId }, 'Failed to delete old event from cache');
        }
      }

      // Merge with existing event IDs (excluding deleted ones)
      const mergedEventIds = Array.from(new Set([...existingEntry?.eventIds.filter(id => !eventsToDelete.has(id)) || [], ...newEventIds]));

      // Update filter cache entry (using same transaction)
      const filterEntry: FilterCacheEntry = {
        filterKey,
        eventIds: mergedEventIds,
        cachedAt: now,
        ttl: effectiveTTL
      };

      try {
        await new Promise<void>((resolve, reject) => {
          const request = filterStore.put(filterEntry);
          request.onsuccess = () => resolve();
          request.onerror = () => {
            const err = request.error;
            // Handle transaction errors gracefully
            if (err instanceof DOMException && 
                (err.name === 'TransactionInactiveError' || err.name === 'InvalidStateError')) {
              logger.debug({ error: err }, 'IndexedDB request error in filter store, transaction inactive');
              resolve(); // Don't reject, just skip this write
              return;
            }
            reject(err);
          };
        });

        // Wait for transaction to complete
        await new Promise<void>((resolve, reject) => {
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => {
            const err = transaction.error;
            // Handle transaction errors gracefully
            if (err instanceof DOMException && 
                (err.name === 'TransactionInactiveError' || err.name === 'InvalidStateError')) {
              logger.debug({ error: err }, 'IndexedDB transaction error, transaction inactive');
              resolve(); // Don't reject, just skip
              return;
            }
            reject(err);
          };
        });
      } catch (err) {
        // If it's a transaction error, handle gracefully
        if (err instanceof DOMException && 
            (err.name === 'TransactionInactiveError' || err.name === 'InvalidStateError')) {
          logger.debug({ error: err }, 'IndexedDB transaction error during filter update, skipping');
          return; // Don't throw, just skip this write
        }
        throw err; // Re-throw other errors
      }

      // Also update in-memory cache for fast access
      // Use the events we're setting (they'll be merged with existing in get() if needed)
      if (events.length > 0) {
        this.updateMemoryCache(filterKey, events, effectiveTTL);
      }

      logger.debug({ 
        filterKey, 
        eventCount: events.length, 
        mergedCount: mergedEventIds.length,
        ttl: effectiveTTL 
      }, 'Cached events in IndexedDB');
    } catch (error) {
      // Check error message first (works for all error types)
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorName = error instanceof DOMException ? error.name : '';
      
      // Check if it's a quota exceeded error
      if (error instanceof DOMException && error.name === 'QuotaExceededError') {
        logger.warn({ error, filters }, 'IndexedDB quota exceeded, skipping cache write');
        return; // Don't throw, just skip this write
      }
      
      // Check if it's any transaction-related error (by name or message)
      // DOMException can have various names: TransactionInactiveError, InvalidStateError, AbortError, etc.
      // Also check for any DOMException that might be transaction-related
      const isTransactionError = 
        (error instanceof DOMException && (
          error.name === 'TransactionInactiveError' || 
          error.name === 'InvalidStateError' ||
          error.name === 'AbortError' ||
          error.name === 'ConstraintError' ||
          error.name === 'DataError'
        )) ||
        errorMessage.toLowerCase().includes('transaction') ||
        errorMessage.toLowerCase().includes('indexeddb') ||
        errorMessage.toLowerCase().includes('inactive') ||
        errorName.toLowerCase().includes('transaction') ||
        errorName.toLowerCase().includes('inactive');
      
      if (isTransactionError) {
        // All transaction-related errors should be logged as debug, not error
        logger.debug({ error, filters, errorName }, 'IndexedDB transaction error, likely concurrent write, skipping');
        return; // Don't throw, just skip this write
      }
      
      // For any other DOMException, treat as potentially recoverable and log as debug
      if (error instanceof DOMException) {
        logger.debug({ error, filters, errorName }, 'IndexedDB error (DOMException), skipping cache write');
        return; // Don't throw, just skip this write
      }
      
      // Only log as ERROR if it's not a DOMException or transaction-related error
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
    
    // Clear in-memory cache entries that might contain events from this pubkey
    // We need to check each entry and remove if it contains events from this pubkey
    for (const [key, entry] of this.memoryCache.entries()) {
      if (entry.events.some(e => e.pubkey === pubkey)) {
        this.memoryCache.delete(key);
      }
    }
    
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

      // Clear in-memory cache entries that contain deleted events
      for (const [key, entry] of this.memoryCache.entries()) {
        const hasDeletedEvent = entry.events.some(e => 
          deletedEventIds.has(e.id) || 
          (REPLACEABLE_KINDS.includes(e.kind) && deletedAddresses.has(`${e.kind}:${e.pubkey}:${e.tags.find(t => t[0] === 'd')?.[1] || ''}`))
        );
        if (hasDeletedEvent) {
          this.memoryCache.delete(key);
        }
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

  /**
   * Delete a single event from the cache by event ID
   */
  async deleteEvent(eventId: string): Promise<void> {
    await this.init();
    
    if (!this.db) {
      return;
    }

    try {
      const transaction = this.db.transaction([STORE_EVENTS, STORE_FILTERS], 'readwrite');
      const eventStore = transaction.objectStore(STORE_EVENTS);
      const filterStore = transaction.objectStore(STORE_FILTERS);

      // Delete from events store
      await new Promise<void>((resolve, reject) => {
        const req = eventStore.delete(eventId);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });

      // Remove from all filter entries that reference this event
      const filterCursor = filterStore.openCursor();
      await new Promise<void>((resolve, reject) => {
        filterCursor.onsuccess = (evt) => {
          const cursor = (evt.target as IDBRequest<IDBCursorWithValue>).result;
          if (cursor) {
            const filterEntry = cursor.value;
            if (filterEntry.eventIds && filterEntry.eventIds.includes(eventId)) {
              filterEntry.eventIds = filterEntry.eventIds.filter((id: string) => id !== eventId);
              cursor.update(filterEntry);
            }
            cursor.continue();
          } else {
            resolve();
          }
        };
        filterCursor.onerror = () => reject(filterCursor.error);
      });

      // Also remove from memory cache
      for (const [filterKey, cacheEntry] of this.memoryCache.entries()) {
        const index = cacheEntry.events.findIndex(e => e.id === eventId);
        if (index !== -1) {
          cacheEntry.events.splice(index, 1);
        }
      }
    } catch (error) {
      logger.debug({ error, eventId }, 'Error deleting event from cache');
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
