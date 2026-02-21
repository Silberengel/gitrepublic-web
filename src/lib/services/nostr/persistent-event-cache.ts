/**
 * Persistent event cache using IndexedDB for client-side storage
 * Simplified, efficient implementation with lazy logger import
 */

import type { NostrEvent, NostrFilter } from '../../types/nostr.js';
import { KIND } from '../../types/nostr.js';
import type { NostrClient } from './nostr-client.js';
import type { Logger } from '../../types/logger.js';

// Lazy logger import to avoid initialization order issues
let loggerCache: Logger | null = null;
let loggerPromise: Promise<Logger> | null = null;

const getLogger = async (): Promise<Logger> => {
  if (loggerCache) return loggerCache;
  if (!loggerPromise) {
    loggerPromise = import('../logger.js').then(m => {
      loggerCache = m.default;
      return loggerCache!;
    }).catch(() => {
      // Fallback console logger
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

const DB_NAME = 'gitrepublic_events';
const DB_VERSION = 1;
const STORE_EVENTS = 'events';
const STORE_FILTERS = 'filters';
const STORE_PROFILES = 'profiles';

const REPLACEABLE_KINDS = [0, 3, 10002]; // Profile, Contacts, Relay List
const DEFAULT_TTL = 30 * 60 * 1000; // 30 minutes (increased for better performance)
const PROFILE_TTL = 60 * 60 * 1000; // 60 minutes (increased for profiles)

interface CachedEvent {
  event: NostrEvent;
  cachedAt: number;
}

interface FilterCacheEntry {
  filterKey: string;
  eventIds: string[];
  cachedAt: number;
  ttl: number;
}

function generateFilterKey(filters: NostrFilter[]): string {
  return JSON.stringify(filters.map(f => {
    const sorted = Object.keys(f).sort().reduce((acc, k) => {
      const v = f[k as keyof NostrFilter];
      if (v !== undefined) {
        acc[k] = Array.isArray(v) ? [...v].sort() : v;
      }
      return acc;
    }, {} as Record<string, unknown>);
    return sorted;
  }).sort());
}

export class PersistentEventCache {
  private db: IDBDatabase | null = null;
  private initPromise: Promise<void> | null = null;
  private memoryCache: Map<string, { events: NostrEvent[]; timestamp: number; ttl: number }> = new Map();

  constructor() {
    // Lazy init - don't call logger here
    if (typeof window !== 'undefined' && window.indexedDB) {
      this.init();
    }
  }

  private async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    if (typeof window === 'undefined' || !window.indexedDB) return;

    this.initPromise = (async () => {
      const logger = await getLogger();
      return new Promise<void>((resolve, reject) => {
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
          if (!db.objectStoreNames.contains(STORE_EVENTS)) {
            const store = db.createObjectStore(STORE_EVENTS, { keyPath: 'id' });
            store.createIndex('pubkey', 'event.pubkey', { unique: false });
            store.createIndex('kind', 'event.kind', { unique: false });
          }
          if (!db.objectStoreNames.contains(STORE_FILTERS)) {
            db.createObjectStore(STORE_FILTERS, { keyPath: 'filterKey' });
          }
          if (!db.objectStoreNames.contains(STORE_PROFILES)) {
            db.createObjectStore(STORE_PROFILES, { keyPath: 'pubkey' });
          }
        };
      });
    })();

    return this.initPromise;
  }

  getSync(filters: NostrFilter[]): NostrEvent[] | null {
    const filterKey = generateFilterKey(filters);
    const entry = this.memoryCache.get(filterKey);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > entry.ttl) {
      this.memoryCache.delete(filterKey);
      return null;
    }
    return entry.events;
  }

  async get(filters: NostrFilter[]): Promise<NostrEvent[] | null> {
    // Check memory cache first
    const memoryCached = this.getSync(filters);
    if (memoryCached) return memoryCached;

    await this.init();
    if (!this.db) return null;

    try {
      const filterKey = generateFilterKey(filters);
      const filterStore = this.db.transaction([STORE_FILTERS], 'readonly').objectStore(STORE_FILTERS);
      const filterEntry = await new Promise<FilterCacheEntry | null>((resolve) => {
        const req = filterStore.get(filterKey);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });

      if (!filterEntry) return null;
      if (Date.now() - filterEntry.cachedAt > filterEntry.ttl) return null;

      const eventStore = this.db.transaction([STORE_EVENTS], 'readonly').objectStore(STORE_EVENTS);
      const events: NostrEvent[] = [];

      for (const eventId of filterEntry.eventIds) {
        const cached = await new Promise<CachedEvent | null>((resolve) => {
          const req = eventStore.get(eventId);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => resolve(null);
        });
        if (cached) events.push(cached.event);
      }

      // Update memory cache
      if (events.length > 0) {
        this.memoryCache.set(filterKey, {
          events,
          timestamp: filterEntry.cachedAt,
          ttl: filterEntry.ttl
        });
      }

      return events.length > 0 ? events : null;
    } catch (error) {
      const logger = await getLogger();
      logger.error({ error, filters }, 'Error reading from cache');
      return null;
    }
  }

  async set(filters: NostrFilter[], events: NostrEvent[], ttl?: number): Promise<void> {
    await this.init();
    if (!this.db || events.length === 0) return;

    try {
      const filterKey = generateFilterKey(filters);
      const effectiveTTL = ttl || DEFAULT_TTL;
      const now = Date.now();

      const transaction = this.db.transaction([STORE_EVENTS, STORE_FILTERS], 'readwrite');
      const eventStore = transaction.objectStore(STORE_EVENTS);
      const filterStore = transaction.objectStore(STORE_FILTERS);

      const eventIds: string[] = [];

      // Store events (only latest for replaceable kinds)
      const latestByKey = new Map<string, NostrEvent>();
      const writeProofPubkeys = new Set<string>(); // Track pubkeys with write-proof events
      
      for (const event of events) {
        // Special handling for gitrepublic-write-proof kind 24 events - treat as replaceable
        let key: string;
        if (REPLACEABLE_KINDS.includes(event.kind)) {
          key = `${event.kind}:${event.pubkey}`;
        } else if (event.kind === KIND.PUBLIC_MESSAGE && event.content && event.content.includes('gitrepublic-write-proof')) {
          key = `24:${event.pubkey}:write-proof`;
          writeProofPubkeys.add(event.pubkey);
        } else {
          key = event.id;
        }
        const existing = latestByKey.get(key);
        if (!existing || event.created_at > existing.created_at) {
          latestByKey.set(key, event);
        }
      }

      // Clean up old write-proof events for pubkeys that have new ones
      if (writeProofPubkeys.size > 0) {
        for (const pubkey of writeProofPubkeys) {
          const key = `24:${pubkey}:write-proof`;
          const newestEvent = latestByKey.get(key);
          if (newestEvent) {
            // Find and delete all older write-proof events for this pubkey
            const pubkeyIndex = eventStore.index('pubkey');
            const cursor = pubkeyIndex.openCursor(IDBKeyRange.only(pubkey));
            await new Promise<void>((resolve) => {
              cursor.onsuccess = (e) => {
                const c = (e.target as IDBRequest<IDBCursorWithValue>).result;
                if (c) {
                  const cached = c.value as CachedEvent;
                  const evt = cached.event;
                  // Delete if it's an old write-proof event (not the newest one)
                  if (evt.kind === KIND.PUBLIC_MESSAGE && 
                      evt.content && 
                      evt.content.includes('gitrepublic-write-proof') &&
                      evt.id !== newestEvent.id &&
                      evt.created_at < newestEvent.created_at) {
                    c.delete();
                  }
                  c.continue();
                } else {
                  resolve();
                }
              };
              cursor.onerror = () => resolve();
            });
          }
        }
      }

      for (const event of latestByKey.values()) {
        await new Promise<void>((resolve, reject) => {
          const req = eventStore.put({ id: event.id, event, cachedAt: now });
          req.onsuccess = () => {
            eventIds.push(event.id);
            resolve();
          };
          req.onerror = () => reject(req.error);
        });
      }

      // Update filter cache
      await new Promise<void>((resolve, reject) => {
        const req = filterStore.put({
          filterKey,
          eventIds,
          cachedAt: now,
          ttl: effectiveTTL
        });
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });

      // Update memory cache
      this.memoryCache.set(filterKey, {
        events: Array.from(latestByKey.values()),
        timestamp: now,
        ttl: effectiveTTL
      });

      const logger = await getLogger();
      logger.debug({ filterKey, eventCount: events.length }, 'Cached events in IndexedDB');
    } catch (error) {
      const logger = await getLogger();
      if (error instanceof DOMException && error.name === 'QuotaExceededError') {
        logger.warn({ error, filters }, 'IndexedDB quota exceeded');
        return;
      }
      logger.error({ error, filters }, 'Error writing to cache');
    }
  }

  async getProfile(pubkey: string): Promise<NostrEvent | null> {
    await this.init();
    if (!this.db) return null;

    try {
      const store = this.db.transaction([STORE_PROFILES], 'readonly').objectStore(STORE_PROFILES);
      const cached = await new Promise<CachedEvent | null>((resolve) => {
        const req = store.get(pubkey);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });

      if (!cached) return null;
      if (Date.now() - cached.cachedAt > PROFILE_TTL) return null;
      return cached.event;
    } catch (error) {
      const logger = await getLogger();
      logger.error({ error, pubkey }, 'Error reading profile from cache');
      return null;
    }
  }

  async setProfile(pubkey: string, event: NostrEvent): Promise<void> {
    await this.init();
    if (!this.db || event.kind !== 0) return;

    try {
      const existing = await this.getProfile(pubkey);
      if (existing && existing.created_at >= event.created_at) return;

      const store = this.db.transaction([STORE_PROFILES], 'readwrite').objectStore(STORE_PROFILES);
      await new Promise<void>((resolve, reject) => {
        const req = store.put({ pubkey, event, cachedAt: Date.now() });
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });

      // Also store in events store
      const eventStore = this.db.transaction([STORE_EVENTS], 'readwrite').objectStore(STORE_EVENTS);
      await new Promise<void>((resolve, reject) => {
        const req = eventStore.put({ id: event.id, event, cachedAt: Date.now() });
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch (error) {
      const logger = await getLogger();
      logger.error({ error, pubkey }, 'Error writing profile to cache');
    }
  }

  async invalidate(filters: NostrFilter[]): Promise<void> {
    await this.init();
    if (!this.db) return;

    try {
      const filterKey = generateFilterKey(filters);
      const store = this.db.transaction([STORE_FILTERS], 'readwrite').objectStore(STORE_FILTERS);
      await new Promise<void>((resolve, reject) => {
        const req = store.delete(filterKey);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch (error) {
      const logger = await getLogger();
      logger.error({ error, filters }, 'Error invalidating cache');
    }
  }

  async cleanup(): Promise<void> {
    await this.init();
    if (!this.db) return;

    try {
      const now = Date.now();
      const filterStore = this.db.transaction([STORE_FILTERS], 'readwrite').objectStore(STORE_FILTERS);
      const cursor = filterStore.openCursor();

      await new Promise<void>((resolve) => {
        cursor.onsuccess = (event) => {
          const c = (event.target as IDBRequest<IDBCursorWithValue>).result;
          if (c) {
            const entry = c.value as FilterCacheEntry;
            if (now - entry.cachedAt > entry.ttl) {
              c.delete();
            }
            c.continue();
          } else {
            resolve();
          }
        };
        cursor.onerror = () => resolve();
      });
    } catch (error) {
      const logger = await getLogger();
      logger.error({ error }, 'Error during cleanup');
    }
  }

  async deleteEvent(eventId: string): Promise<void> {
    await this.init();
    if (!this.db) return;

    try {
      // Remove from IndexedDB
      const eventStore = this.db.transaction([STORE_EVENTS], 'readwrite').objectStore(STORE_EVENTS);
      await new Promise<void>((resolve) => {
        const req = eventStore.delete(eventId);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
      });

      // Remove from memory cache
      for (const [key, entry] of this.memoryCache.entries()) {
        entry.events = entry.events.filter(e => e.id !== eventId);
        if (entry.events.length === 0) {
          this.memoryCache.delete(key);
        }
      }

      // Remove from filter cache entries
      const filterStore = this.db.transaction([STORE_FILTERS], 'readwrite').objectStore(STORE_FILTERS);
      const cursor = filterStore.openCursor();
      await new Promise<void>((resolve) => {
        cursor.onsuccess = (event) => {
          const c = (event.target as IDBRequest<IDBCursorWithValue>).result;
          if (c) {
            const entry = c.value as FilterCacheEntry;
            entry.eventIds = entry.eventIds.filter(id => id !== eventId);
            c.update(entry);
            c.continue();
          } else {
            resolve();
          }
        };
        cursor.onerror = () => resolve();
      });
    } catch (error) {
      const logger = await getLogger();
      logger.debug({ error, eventId }, 'Error deleting event from cache');
    }
  }

  async processDeletionEvents(deletionEvents: NostrEvent[]): Promise<void> {
    if (deletionEvents.length === 0) return;

    const deletedIds = new Set<string>();
    for (const event of deletionEvents) {
      if (event.kind !== KIND.DELETION_REQUEST) continue;
      for (const tag of event.tags) {
        if (tag[0] === 'e' && tag[1]) deletedIds.add(tag[1]);
      }
    }

    if (deletedIds.size === 0) return;

    await this.init();
    if (!this.db) return;

    try {
      const eventStore = this.db.transaction([STORE_EVENTS], 'readwrite').objectStore(STORE_EVENTS);
      for (const eventId of deletedIds) {
        await new Promise<void>((resolve) => {
          const req = eventStore.delete(eventId);
          req.onsuccess = () => resolve();
          req.onerror = () => resolve();
        });
      }

      // Remove from memory cache
      for (const [key, entry] of this.memoryCache.entries()) {
        entry.events = entry.events.filter(e => !deletedIds.has(e.id));
        if (entry.events.length === 0) {
          this.memoryCache.delete(key);
        }
      }

      const logger = await getLogger();
      logger.debug({ removedCount: deletedIds.size }, 'Processed deletion events');
    } catch (error) {
      const logger = await getLogger();
      logger.error({ error }, 'Error processing deletion events');
    }
  }

  async invalidatePubkey(pubkey: string): Promise<void> {
    await this.init();
    if (!this.db) return;

    try {
      // Remove from profiles store
      const profileStore = this.db.transaction([STORE_PROFILES], 'readwrite').objectStore(STORE_PROFILES);
      await new Promise<void>((resolve) => {
        const req = profileStore.delete(pubkey);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
      });

      // Remove events from events store
      const eventStore = this.db.transaction([STORE_EVENTS], 'readwrite').objectStore(STORE_EVENTS);
      const index = eventStore.index('pubkey');
      const cursor = index.openKeyCursor(IDBKeyRange.only(pubkey));
      await new Promise<void>((resolve) => {
        cursor.onsuccess = (event) => {
          const c = (event.target as IDBRequest<IDBCursorWithValue>).result;
          if (c) {
            eventStore.delete(c.primaryKey);
            c.continue();
          } else {
            resolve();
          }
        };
        cursor.onerror = () => resolve();
      });

      // Remove from memory cache
      for (const [key, entry] of this.memoryCache.entries()) {
        entry.events = entry.events.filter(e => e.pubkey !== pubkey);
        if (entry.events.length === 0) {
          this.memoryCache.delete(key);
        }
      }
    } catch (error) {
      const logger = await getLogger();
      logger.error({ error, pubkey }, 'Error invalidating pubkey cache');
    }
  }

  async fetchAndProcessDeletions(nostrClient: NostrClient, userPubkeys: string[] = []): Promise<void> {
    if (userPubkeys.length === 0) return;

    try {
      const deletionEvents = await nostrClient.fetchEvents([{
        kinds: [KIND.DELETION_REQUEST],
        authors: userPubkeys,
        limit: 100
      }]);

      await this.processDeletionEvents(deletionEvents);
    } catch (error) {
      const logger = await getLogger();
      logger.error({ error }, 'Error fetching and processing deletions');
    }
  }
}

// Singleton instance - created lazily, no logger calls in constructor
export const persistentEventCache = new PersistentEventCache();

// Setup cleanup interval (only in browser)
if (typeof window !== 'undefined') {
  setInterval(() => {
    persistentEventCache.cleanup().catch(async (err) => {
      const logger = await getLogger();
      logger.error({ error: err }, 'Error during scheduled cleanup');
    });
  }, 60 * 60 * 1000); // 1 hour

  // Setup deletion processing
  (window as any).__startDeletionProcessing = async (nostrClient: any, userPubkeys: string[] = []) => {
    let interval: ReturnType<typeof setInterval> | null = null;
    
    const process = () => {
      persistentEventCache.fetchAndProcessDeletions(nostrClient, userPubkeys).catch(async (err) => {
        const logger = await getLogger();
        logger.debug({ error: err }, 'Error during deletion processing');
      });
    };

    process(); // Process immediately
    interval = setInterval(process, 15 * 60 * 1000); // Then every 15 minutes
  };
}
