/**
 * Nostr client for fetching and publishing events
 * Uses nostr-tools Pool for relay connection management
 */

import type { NostrEvent, NostrFilter } from '../../types/nostr.js';
import logger from '../logger.js';
import { isNIP07Available, getPublicKeyWithNIP07, signEventWithNIP07 } from './nip07-signer.js';
import { SimplePool, type Filter } from 'nostr-tools';
import { KIND } from '../../types/nostr.js';
import { isParameterizedReplaceable } from '../../utils/nostr-event-utils.js';
import { FALLBACK_NOSTR_RELAYS } from '../../config.js';

// Replaceable event kinds (only latest per pubkey matters)
const REPLACEABLE_KINDS = [0, 3, 10002]; // Profile, Contacts, Relay List

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
  // Special handling for gitrepublic-write-proof kind 24 events - treat as replaceable
  if (event.kind === KIND.PUBLIC_MESSAGE && event.content && event.content.includes('gitrepublic-write-proof')) {
    return `24:${event.pubkey}:write-proof`;
  }
  return event.id;
}

// Lazy load persistent cache (only in browser)
let persistentEventCache: typeof import('./persistent-event-cache.js').persistentEventCache | null = null;
async function getPersistentCache() {
  if (typeof window === 'undefined') {
    return null; // Server-side, no IndexedDB
  }
  if (!persistentEventCache) {
    try {
      const module = await import('./persistent-event-cache.js');
      persistentEventCache = module.persistentEventCache;
    } catch (error) {
      logger.debug({ error }, 'Persistent cache not available');
      return null;
    }
  }
  return persistentEventCache;
}

// Polyfill WebSocket for Node.js environments (lazy initialization)
// Note: The 'module' import warning in browser builds is expected and harmless.
// This code only executes in Node.js/server environments.
let wsPolyfillInitialized = false;
async function initializeWebSocketPolyfill() {
  if (wsPolyfillInitialized) return;
  
  // Check if WebSocket already exists (browser or already polyfilled)
  if (typeof WebSocket !== 'undefined') {
    wsPolyfillInitialized = true;
    return;
  }
  
  // Skip in browser environment - WebSocket should be native
  if (typeof window !== 'undefined') {
    wsPolyfillInitialized = true;
    return;
  }
  
  // Only run in Node.js/server environment
  if (typeof process === 'undefined' || !process.versions?.node) {
    wsPolyfillInitialized = true;
    return;
  }
  
  // Only attempt polyfill in Node.js runtime
  // This import is only executed server-side, but Vite may still analyze it
  try {
    // @ts-ignore - Dynamic import that only runs in Node.js
    const moduleModule = await import('module');
    const requireFunc = moduleModule.createRequire(import.meta.url);
    const WebSocketImpl = requireFunc('ws');
    (global as any).WebSocket = WebSocketImpl;
    wsPolyfillInitialized = true;
  } catch (error) {
    // ws package not available or import failed
    // This is expected in browser builds, so we don't warn
    wsPolyfillInitialized = true; // Mark as initialized to avoid repeated attempts
  }
}

// Initialize on module load if in Node.js (fire and forget)
// Only in SSR/server environment - check for window to exclude browser
if (typeof process !== 'undefined' && process.versions?.node && typeof window === 'undefined') {
  initializeWebSocketPolyfill().catch(() => {
    // Ignore errors during initialization
  });
}

// Note: SimplePool from nostr-tools handles WebSocket connections automatically
// Tor support would require custom WebSocket factory, which SimplePool doesn't easily support
// For now, we rely on SimplePool's built-in connection management

export class NostrClient {
  private relays: string[] = [];
  private pool: SimplePool;
  private authenticatedRelays: Set<string> = new Set();
  private processingDeletions: boolean = false; // Guard to prevent recursive deletion processing

  constructor(relays: string[]) {
    this.relays = relays;
    // Use nostr-tools SimplePool for relay connection management
    // SimplePool handles all WebSocket connections, retries, and error handling automatically
    this.pool = new SimplePool();
  }

  /**
   * Clean up pool connections when done
   */
  close(): void {
    this.pool.close(this.relays);
  }

  /**
   * Handle AUTH challenge from relay and authenticate using NIP-42
   * Note: SimplePool doesn't expose WebSocket directly, so AUTH handling
   * may need to be done differently. For now, this is kept for compatibility.
   */
  private async handleAuthChallenge(ws: WebSocket, relay: string, challenge: string): Promise<boolean> {
    // Only try to authenticate if NIP-07 is available (browser environment)
    if (typeof window === 'undefined' || !isNIP07Available()) {
      return false;
    }

    try {
      const pubkey = await getPublicKeyWithNIP07();
      
      // Create auth event (kind 22242)
      const authEvent: Omit<NostrEvent, 'sig' | 'id'> = {
        kind: 22242,
        pubkey,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: challenge
      };

      // Sign the event (NIP-07 will calculate the ID)
      const signedEvent = await signEventWithNIP07(authEvent);
      
      // Send AUTH response
      ws.send(JSON.stringify(['AUTH', signedEvent]));
      
      // Wait for OK response with timeout
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          resolve(false);
        }, 5000);

        const okHandler = (event: MessageEvent) => {
          try {
            const message = JSON.parse(event.data);
            if (message[0] === 'OK' && message[1] === 'auth') {
              clearTimeout(timeout);
              ws.removeEventListener('message', okHandler);
              if (message[2] === true) {
                this.authenticatedRelays.add(relay);
                resolve(true);
              } else {
                logger.warn({ relay, reason: message[3] }, 'AUTH rejected by relay');
                resolve(false);
              }
            }
          } catch {
            // Ignore parse errors, continue waiting
          }
        };
        
        ws.addEventListener('message', okHandler);
      });
    } catch (error) {
      logger.error({ error, relay }, 'Failed to authenticate with relay');
      return false;
    }
  }

  async fetchEvents(filters: NostrFilter[]): Promise<NostrEvent[]> {
    // Strategy: Check persistent cache first, return immediately if available
    // Then fetch from relays in background and merge results
    
    // Skip cache for search queries - search results should always be fresh
    const hasSearchQuery = filters.some(f => f.search && f.search.trim().length > 0);
    
    if (!hasSearchQuery) {
      // Check persistent cache (has built-in in-memory layer for fast access)
      const persistentCache = await getPersistentCache();
      if (persistentCache) {
        try {
          // First try synchronous memory cache (fast)
          const memoryCached = persistentCache.getSync(filters);
          if (memoryCached && memoryCached.length > 0) {
            logger.debug({ filters, cachedCount: memoryCached.length }, 'Returning cached events from memory');
            
            // Return cached events immediately, but also fetch from relays in background to update cache
            this.fetchAndMergeFromRelays(filters, memoryCached).catch(err => {
              logger.debug({ error: err, filters }, 'Background fetch failed, using cached events');
            });
            
            return memoryCached;
          }
          
          // If not in memory, check IndexedDB (async)
          const cachedEvents = await persistentCache.get(filters);
          if (cachedEvents && cachedEvents.length > 0) {
            logger.debug({ filters, cachedCount: cachedEvents.length }, 'Returning cached events from IndexedDB');
            
            // Return cached events immediately, but also fetch from relays in background to update cache
            this.fetchAndMergeFromRelays(filters, cachedEvents).catch(err => {
              logger.debug({ error: err, filters }, 'Background fetch failed, using cached events');
            });
            
            return cachedEvents;
          }
        } catch (error) {
          logger.debug({ error, filters }, 'Error reading from persistent cache, falling back');
        }
      }
    } else {
      logger.debug({ filters }, 'Skipping cache for search query');
    }
    
    // 3. No cache available (or search query), fetch from relays
    return this.fetchAndMergeFromRelays(filters, []);
  }

  /**
   * Sanitize a filter to ensure all values are valid
   * Removes invalid authors (non-strings, null, undefined, non-hex)
   * Ensures all array fields contain only valid strings
   */
  private sanitizeFilter(filter: NostrFilter): Filter {
    const sanitized: Filter = {};
    
    // Sanitize authors - must be array of valid hex pubkeys (64 chars)
    if (filter.authors) {
      const validAuthors = filter.authors
        .filter((author): author is string => 
          typeof author === 'string' && 
          author.length === 64 && 
          /^[0-9a-f]{64}$/i.test(author)
        );
      if (validAuthors.length > 0) {
        sanitized.authors = validAuthors;
      }
    }
    
    // Sanitize ids - must be array of valid hex strings (64 chars)
    if (filter.ids) {
      const validIds = filter.ids
        .filter((id): id is string => 
          typeof id === 'string' && 
          id.length === 64 && 
          /^[0-9a-f]{64}$/i.test(id)
        );
      if (validIds.length > 0) {
        sanitized.ids = validIds;
      }
    }
    
    // Sanitize kinds - must be array of numbers
    if (filter.kinds) {
      const validKinds = filter.kinds.filter((kind): kind is number => typeof kind === 'number');
      if (validKinds.length > 0) {
        sanitized.kinds = validKinds;
      }
    }
    
    // Sanitize tag filters - must be arrays of strings
    const tagFields = ['#e', '#p', '#d', '#a', '#E', '#K', '#P', '#A', '#I'] as const;
    for (const tagField of tagFields) {
      const value = filter[tagField];
      if (value) {
        const validValues = value.filter((v): v is string => typeof v === 'string' && v.length > 0);
        if (validValues.length > 0) {
          sanitized[tagField] = validValues;
        }
      }
    }
    
    // Copy other valid fields
    if (filter.since !== undefined && typeof filter.since === 'number') {
      sanitized.since = filter.since;
    }
    if (filter.until !== undefined && typeof filter.until === 'number') {
      sanitized.until = filter.until;
    }
    if (filter.limit !== undefined && typeof filter.limit === 'number' && filter.limit > 0) {
      sanitized.limit = filter.limit;
    }
    if (filter.search && typeof filter.search === 'string') {
      sanitized.search = filter.search;
    }
    
    return sanitized;
  }

  /**
   * Fetch events from relays and merge with existing events
   * Never deletes valid events, only appends/integrates new ones
   * Automatically falls back to fallback relays if primary relays fail
   */
  private async fetchAndMergeFromRelays(filters: NostrFilter[], existingEvents: NostrEvent[]): Promise<NostrEvent[]> {
    const events: NostrEvent[] = [];
    
    // Sanitize all filters before sending to relays
    const sanitizedFilters = filters.map(f => this.sanitizeFilter(f));
    
    // Use nostr-tools SimplePool to fetch from all relays in parallel
    // SimplePool handles connection management, retries, and error handling automatically
    try {
      // querySync takes a single filter, so we query each filter and combine results
      // Wrap each query individually to catch errors from individual relays
      const queryPromises = sanitizedFilters.map(filter => 
        this.pool.querySync(this.relays, filter, { maxWait: 8000 })
          .catch(err => {
            // Log individual relay errors but don't fail the entire request
            logger.debug({ error: err, filter, relays: this.relays }, 'Primary relay query failed, trying fallback');
            return []; // Return empty array for failed queries
          })
      );
      const results = await Promise.allSettled(queryPromises);
      
      let hasResults = false;
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value.length > 0) {
          events.push(...result.value);
          hasResults = true;
        } else if (result.status === 'rejected') {
          // Log rejected promises (shouldn't happen since we catch above, but just in case)
          logger.debug({ error: result.reason }, 'Query promise rejected');
        }
      }
      
      // If no results from primary relays and we have fallback relays, try them
      if (!hasResults && events.length === 0 && FALLBACK_NOSTR_RELAYS.length > 0) {
        logger.debug({ primaryRelays: this.relays, fallbackRelays: FALLBACK_NOSTR_RELAYS }, 'No results from primary relays, trying fallback relays');
        try {
          const fallbackPromises = sanitizedFilters.map(filter => 
            this.pool.querySync(FALLBACK_NOSTR_RELAYS, filter, { maxWait: 8000 })
              .catch(err => {
                logger.debug({ error: err, filter }, 'Fallback relay query failed');
                return [];
              })
          );
          const fallbackResults = await Promise.allSettled(fallbackPromises);
          
          for (const result of fallbackResults) {
            if (result.status === 'fulfilled') {
              events.push(...result.value);
            }
          }
          
          if (events.length > 0) {
            logger.info({ fallbackRelays: FALLBACK_NOSTR_RELAYS, eventCount: events.length }, 'Successfully fetched events from fallback relays');
          }
        } catch (fallbackErr) {
          logger.debug({ error: fallbackErr }, 'Fallback relay query failed completely');
        }
      }
    } catch (err) {
      logger.debug({ error: err, filters }, 'Pool querySync failed');
      // Continue with empty events - will use cached events
    }
    
    // Merge with existing events - handle replaceable and parameterized replaceable events
    // Map: deduplication key -> latest event
    const eventMap = new Map<string, NostrEvent>();
    const eventsToDelete = new Set<string>(); // Event IDs to delete from cache
    
    // Add existing events first, indexed by deduplication key
    for (const event of existingEvents) {
      const key = getDeduplicationKey(event);
      const existing = eventMap.get(key);
      // Keep the newest if there are duplicates
      if (!existing || event.created_at > existing.created_at) {
        if (existing) {
          eventsToDelete.add(existing.id); // Mark older event for deletion
        }
        eventMap.set(key, event);
      } else {
        eventsToDelete.add(event.id); // This one is older
      }
    }
    
    // Add/update with new events from relays
    for (const event of events) {
      const key = getDeduplicationKey(event);
      const existing = eventMap.get(key);
      
      if (!existing || event.created_at > existing.created_at) {
        // New event is newer (or first occurrence)
        if (existing) {
          eventsToDelete.add(existing.id); // Mark older event for deletion
        }
        eventMap.set(key, event);
      } else {
        // Existing event is newer, mark this one for deletion
        eventsToDelete.add(event.id);
      }
    }
    
    // eventMap already contains only the latest events per deduplication key
    // No need to remove from eventMap - the merge logic above already handles that
    const finalEvents = Array.from(eventMap.values());
    
    // Sort by created_at descending
    finalEvents.sort((a, b) => b.created_at - a.created_at);
    
    // Get persistent cache once (if available)
    const persistentCache = await getPersistentCache();
    
    // Delete older events from cache if we have newer ones
    if (persistentCache && eventsToDelete.size > 0) {
      for (const eventId of eventsToDelete) {
        persistentCache.deleteEvent(eventId).catch((err: unknown) => {
          logger.debug({ error: err, eventId }, 'Failed to delete old event from cache');
        });
      }
    }
    
    // Cache in persistent cache (has built-in in-memory layer)
    // For kind 0 (profile) events, also cache individually by pubkey
    const profileEvents = finalEvents.filter(e => e.kind === 0);
    for (const profileEvent of profileEvents) {
      // Cache profile in persistent cache (which also updates its memory layer)
      if (persistentCache) {
        persistentCache.setProfile(profileEvent.pubkey, profileEvent).catch(err => {
          logger.debug({ error: err, pubkey: profileEvent.pubkey }, 'Failed to cache profile');
        });
      }
    }
    
    // Cache the merged results (skip cache for search queries)
    const hasSearchQuery = filters.some(f => f.search && f.search.trim().length > 0);
    if (!hasSearchQuery) {
      if (finalEvents.length > 0 || events.length > 0) {
        // Cache successful fetches for 5 minutes, empty results for 1 minute
        const ttl = finalEvents.length > 0 ? 5 * 60 * 1000 : 60 * 1000;
        
        // Update persistent cache (which also updates its built-in memory layer)
        if (persistentCache) {
          persistentCache.set(filters, finalEvents, ttl).catch(err => {
            logger.debug({ error: err, filters }, 'Failed to update persistent cache');
          });
        }
        
        logger.debug({ 
          filters, 
          eventCount: finalEvents.length, 
          existingCount: existingEvents.length,
          newCount: events.length,
          mergedCount: finalEvents.length,
          ttl, 
          profileEvents: profileEvents.length 
        }, 'Merged and cached events');
      }
    } else {
      logger.debug({ filters }, 'Skipping cache for search query results');
    }
    
    // Process deletion events in the background (non-blocking)
    // Fetch recent deletion events and remove deleted events from cache
    this.processDeletionsInBackground().catch(err => {
      logger.debug({ error: err }, 'Error processing deletions in background');
    });
    
    return finalEvents;
  }

  /**
   * Process deletion events in the background
   * Fetches recent deletion events and removes deleted events from both caches
   */
  private async processDeletionsInBackground(): Promise<void> {
    if (typeof window === 'undefined' || this.processingDeletions) {
      return; // Only run in browser, and prevent recursive calls
    }

    this.processingDeletions = true;

    try {
      // Fetch recent deletion events (last 24 hours)
      // Use fetchFromRelay directly to avoid triggering another deletion processing cycle
      const since = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
      const events: NostrEvent[] = [];
      
      // Fetch from all relays in parallel using SimplePool, bypassing cache to avoid recursion
      try {
        const relayEvents = await this.pool.querySync(this.relays, {
          kinds: [KIND.DELETION_REQUEST],
          since,
          limit: 100
        } as Filter, { maxWait: 8000 });
        events.push(...relayEvents);
      } catch (err) {
        logger.debug({ error: err }, 'Failed to fetch deletion events from pool');
      }

      // Deduplicate deletion events by ID
      const uniqueDeletionEvents = new Map<string, NostrEvent>();
      for (const event of events) {
        if (!uniqueDeletionEvents.has(event.id) || event.created_at > uniqueDeletionEvents.get(event.id)!.created_at) {
          uniqueDeletionEvents.set(event.id, event);
        }
      }

      const deletionEvents = Array.from(uniqueDeletionEvents.values());

      if (deletionEvents.length > 0) {
        // Process deletions in persistent cache (which also handles its memory layer)
        const persistentCache = await getPersistentCache();
        if (persistentCache && typeof persistentCache.processDeletionEvents === 'function') {
          await persistentCache.processDeletionEvents(deletionEvents);
        }
      }
    } catch (error) {
      logger.debug({ error }, 'Error processing deletions in background');
    } finally {
      this.processingDeletions = false;
    }
  }


  async publishEvent(event: NostrEvent, relays?: string[]): Promise<{ success: string[]; failed: Array<{ relay: string; error: string }> }> {
    const targetRelays = relays || this.relays;
    const success: string[] = [];
    const failed: Array<{ relay: string; error: string }> = [];
    
    // Use nostr-tools SimplePool to publish to all relays
    // SimplePool.publish can throw errors from WebSocket handlers that aren't caught by normal try-catch
    // We need to wrap it carefully to catch all errors
    try {
      // Wrap publish in a promise that catches all errors, including unhandled promise rejections
      const publishPromise = new Promise<string[]>((resolve, reject) => {
        // Set up a timeout to prevent hanging
        const timeout = setTimeout(() => {
          reject(new Error('Publish timeout after 30 seconds'));
        }, 30000);
        
        // Publish to relays - wrap in try-catch to catch synchronous errors
        try {
          // SimplePool.publish returns Promise<string>[] (array of promises, one per relay)
          // We need to use Promise.all() to wait for all of them
          const poolPublishPromises = this.pool.publish(targetRelays, event);
          
          // Handle the promise results
          Promise.all(poolPublishPromises)
            .then((results) => {
              clearTimeout(timeout);
              // results is string[] - the relay URLs that succeeded
              // If all succeeded, results should contain all targetRelays
              resolve(results);
            })
            .catch((error: unknown) => {
              clearTimeout(timeout);
              // Handle specific relay errors gracefully
              const errorMessage = error instanceof Error ? error.message : String(error);
              
              // Check for common relay error messages that shouldn't be fatal
              if (errorMessage.includes('restricted') || 
                  errorMessage.includes('Pay on') ||
                  errorMessage.includes('payment required') ||
                  errorMessage.includes('rate limit')) {
                // These are relay-specific restrictions, not fatal errors
                // Log but don't fail - we'll mark relays as failed below
                logger.debug({ error: errorMessage, eventId: event.id }, 'Relay restriction encountered (payment/rate limit)');
                // Resolve with empty success - we'll mark all as failed below
                resolve([]);
              } else {
                // Other errors should be rejected
                reject(error);
              }
            });
        } catch (syncError) {
          // Catch any synchronous errors
          clearTimeout(timeout);
          reject(syncError);
        }
      });
      
      // Wait for publish with timeout and catch all errors
      const publishedRelays: string[] = await Promise.race([
        publishPromise,
        new Promise<string[]>((_, reject) => 
          setTimeout(() => reject(new Error('Publish timeout')), 30000)
        )
      ]).catch((error: unknown): string[] => {
        // Log error but don't throw - we'll mark relays as failed below
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.debug({ error: errorMessage, eventId: event.id }, 'Error publishing event to relays');
        return [];
      });
      
      if (publishedRelays && publishedRelays.length > 0) {
        success.push(...publishedRelays);
        // Mark any relays not in success as failed
        targetRelays.forEach(relay => {
          if (!publishedRelays.includes(relay)) {
            failed.push({ relay, error: 'Relay did not accept event' });
          }
        });
      } else {
        // If publish failed or timed out to primary relays, try fallback relays
        if (FALLBACK_NOSTR_RELAYS.length > 0) {
          logger.debug({ primaryRelays: targetRelays, fallbackRelays: FALLBACK_NOSTR_RELAYS, eventId: event.id }, 'Primary relay publish failed, trying fallback relays');
          
          try {
            const fallbackPublishPromise = new Promise<string[]>((resolve, reject) => {
              const timeout = setTimeout(() => {
                reject(new Error('Fallback publish timeout after 30 seconds'));
              }, 30000);
              
              try {
                const fallbackPublishPromises = this.pool.publish(FALLBACK_NOSTR_RELAYS, event);
                Promise.all(fallbackPublishPromises)
                  .then((results) => {
                    clearTimeout(timeout);
                    resolve(results);
                  })
                  .catch((error: unknown) => {
                    clearTimeout(timeout);
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    if (errorMessage.includes('restricted') || 
                        errorMessage.includes('Pay on') ||
                        errorMessage.includes('payment required') ||
                        errorMessage.includes('rate limit')) {
                      logger.debug({ error: errorMessage, eventId: event.id }, 'Fallback relay restriction encountered');
                      resolve([]);
                    } else {
                      reject(error);
                    }
                  });
              } catch (syncError) {
                clearTimeout(timeout);
                reject(syncError);
              }
            });
            
            const fallbackPublishedRelays: string[] = await Promise.race([
              fallbackPublishPromise,
              new Promise<string[]>((_, reject) => 
                setTimeout(() => reject(new Error('Fallback publish timeout')), 30000)
              )
            ]).catch((error: unknown): string[] => {
              logger.debug({ error: error instanceof Error ? error.message : String(error), eventId: event.id }, 'Error publishing to fallback relays');
              return [];
            });
            
            if (fallbackPublishedRelays && fallbackPublishedRelays.length > 0) {
              success.push(...fallbackPublishedRelays);
              logger.info({ fallbackRelays: FALLBACK_NOSTR_RELAYS, publishedCount: fallbackPublishedRelays.length, eventId: event.id }, 'Successfully published to fallback relays');
              // Mark primary relays as failed
              targetRelays.forEach(relay => {
                failed.push({ relay, error: 'Primary relay failed, used fallback' });
              });
              // Mark fallback relays not in success as failed
              FALLBACK_NOSTR_RELAYS.forEach(relay => {
                if (!fallbackPublishedRelays.includes(relay)) {
                  failed.push({ relay, error: 'Fallback relay did not accept event' });
                }
              });
            } else {
              // Both primary and fallback failed
              targetRelays.forEach(relay => {
                failed.push({ relay, error: 'Publish failed or timed out' });
              });
              FALLBACK_NOSTR_RELAYS.forEach(relay => {
                failed.push({ relay, error: 'Fallback relay publish failed or timed out' });
              });
            }
          } catch (fallbackError) {
            logger.debug({ error: fallbackError, eventId: event.id }, 'Fallback relay publish failed completely');
            // Mark all relays as failed
            targetRelays.forEach(relay => {
              failed.push({ relay, error: 'Publish failed or timed out' });
            });
            FALLBACK_NOSTR_RELAYS.forEach(relay => {
              failed.push({ relay, error: 'Fallback relay publish failed' });
            });
          }
        } else {
          // No fallback relays available, mark all primary relays as failed
          targetRelays.forEach(relay => {
            failed.push({ relay, error: 'Publish failed or timed out' });
          });
        }
      }
    } catch (error) {
      // Catch any synchronous errors
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.debug({ error: errorMessage, eventId: event.id }, 'Synchronous error in publishEvent');
      targetRelays.forEach(relay => {
        failed.push({ relay, error: errorMessage });
      });
    }
    
    // Invalidate cache for events from this pubkey (new event published)
    // This ensures fresh data on next fetch
    if (success.length > 0) {
      // Invalidate persistent cache (which also handles its memory layer)
      const persistentCache = await getPersistentCache();
      if (persistentCache) {
        persistentCache.invalidatePubkey(event.pubkey).catch(err => {
          logger.debug({ error: err, pubkey: event.pubkey }, 'Failed to invalidate persistent cache');
        });
      }
      
      logger.debug({ eventId: event.id, pubkey: event.pubkey }, 'Invalidated cache after event publish');
    }
    
    return { success, failed };
  }

}
