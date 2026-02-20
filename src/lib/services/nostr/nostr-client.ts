/**
 * Nostr client for fetching and publishing events
 */

import type { NostrEvent, NostrFilter } from '../../types/nostr.js';
import logger from '../logger.js';
import { isNIP07Available, getPublicKeyWithNIP07, signEventWithNIP07 } from './nip07-signer.js';
import { shouldUseTor, getTorProxy } from '../../utils/tor.js';
import { eventCache } from './event-cache.js';
import { KIND } from '../../types/nostr.js';

// Replaceable event kinds (only latest per pubkey matters)
const REPLACEABLE_KINDS = [0, 3, 10002]; // Profile, Contacts, Relay List

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

/**
 * Create a WebSocket connection, optionally through Tor SOCKS proxy
 */
async function createWebSocketWithTor(url: string): Promise<WebSocket> {
  await initializeWebSocketPolyfill();
  
  // Check if we need Tor
  if (!shouldUseTor(url)) {
    return new WebSocket(url);
  }
  
  // Only use Tor in Node.js environment
  if (typeof process === 'undefined' || !process.versions?.node || typeof window !== 'undefined') {
    // Browser environment - can't use SOCKS proxy directly
    // Fall back to regular WebSocket (will fail for .onion in browser)
    logger.warn({ url }, 'Tor support not available in browser. .onion addresses may not work.');
    return new WebSocket(url);
  }
  
  const proxy = getTorProxy();
  if (!proxy) {
    logger.warn({ url }, 'Tor proxy not configured. Cannot connect to .onion address.');
    return new WebSocket(url);
  }
  
  try {
    // Dynamic import for SOCKS support
    const { SocksClient } = await import('socks');
    const { WebSocket: WS } = await import('ws');
    
    // Parse the WebSocket URL
    const wsUrl = new URL(url);
    const host = wsUrl.hostname;
    const port = wsUrl.port ? parseInt(wsUrl.port, 10) : (wsUrl.protocol === 'wss:' ? 443 : 80);
    
    // Create SOCKS connection
    const socksOptions = {
      proxy: {
        host: proxy.host,
        port: proxy.port,
        type: 5 as const // SOCKS5
      },
      command: 'connect' as const,
      destination: {
        host,
        port
      }
    };
    
    const info = await SocksClient.createConnection(socksOptions);
    
    // Create WebSocket over the SOCKS connection
    // socket option is supported at runtime but not in types
    const ws = new WS(url, {
      socket: info.socket,
      // For wss://, we need to handle TLS
      rejectUnauthorized: false // .onion addresses use self-signed certs
    } as any);
    
    return ws as any as WebSocket;
  } catch (error) {
    logger.error({ error, url, proxy }, 'Failed to create WebSocket through Tor');
    // Fall back to regular connection (will likely fail for .onion)
    return new WebSocket(url);
  }
}

export class NostrClient {
  private relays: string[] = [];
  private authenticatedRelays: Set<string> = new Set();
  private processingDeletions: boolean = false; // Guard to prevent recursive deletion processing

  constructor(relays: string[]) {
    this.relays = relays;
  }

  /**
   * Handle AUTH challenge from relay and authenticate using NIP-42
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
      // 1. Check persistent cache first (IndexedDB) - only in browser
      const persistentCache = await getPersistentCache();
      if (persistentCache) {
        try {
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
      
      // 2. Check in-memory cache as fallback
      const memoryCached = eventCache.get(filters);
      if (memoryCached !== null && memoryCached.length > 0) {
        logger.debug({ filters, cachedCount: memoryCached.length }, 'Returning cached events from memory');
        
        // Also store in persistent cache and fetch from relays in background
        if (persistentCache) {
          persistentCache.set(filters, memoryCached).catch(err => {
            logger.debug({ error: err }, 'Failed to persist cache');
          });
        }
        this.fetchAndMergeFromRelays(filters, memoryCached).catch(err => {
          logger.debug({ error: err, filters }, 'Background fetch failed');
        });
        
        return memoryCached;
      }
    } else {
      logger.debug({ filters }, 'Skipping cache for search query');
    }
    
    // 3. No cache available (or search query), fetch from relays
    return this.fetchAndMergeFromRelays(filters, []);
  }

  /**
   * Fetch events from relays and merge with existing events
   * Never deletes valid events, only appends/integrates new ones
   */
  private async fetchAndMergeFromRelays(filters: NostrFilter[], existingEvents: NostrEvent[]): Promise<NostrEvent[]> {
    const events: NostrEvent[] = [];
    
    // Fetch from all relays in parallel
    const promises = this.relays.map(relay => this.fetchFromRelay(relay, filters));
    const results = await Promise.allSettled(promises);
    
    for (const result of results) {
      if (result.status === 'fulfilled') {
        events.push(...result.value);
      }
    }
    
    // Merge with existing events - never delete valid events
    const eventMap = new Map<string, NostrEvent>();
    
    // Add existing events first
    for (const event of existingEvents) {
      eventMap.set(event.id, event);
    }
    
    // Add/update with new events from relays
    // For replaceable events (kind 0, 3, 10002), use latest per pubkey
    const replaceableEvents = new Map<string, NostrEvent>(); // pubkey -> latest event
    
    for (const event of events) {
      if (REPLACEABLE_KINDS.includes(event.kind)) {
        // Replaceable event - only keep latest per pubkey
        const existing = replaceableEvents.get(event.pubkey);
        if (!existing || event.created_at > existing.created_at) {
          replaceableEvents.set(event.pubkey, event);
        }
      } else {
        // Regular event - add if newer or doesn't exist
        const existing = eventMap.get(event.id);
        if (!existing || event.created_at > existing.created_at) {
          eventMap.set(event.id, event);
        }
      }
    }
    
    // Add replaceable events to the map (replacing older versions)
    for (const [pubkey, event] of replaceableEvents.entries()) {
      // Remove any existing replaceable events for this pubkey
      for (const [id, existingEvent] of eventMap.entries()) {
        if (existingEvent.pubkey === pubkey && REPLACEABLE_KINDS.includes(existingEvent.kind)) {
          eventMap.delete(id);
        }
      }
      eventMap.set(event.id, event);
    }
    
    const finalEvents = Array.from(eventMap.values());
    
    // Sort by created_at descending
    finalEvents.sort((a, b) => b.created_at - a.created_at);
    
    // Get persistent cache once (if available)
    const persistentCache = await getPersistentCache();
    
    // Cache in both persistent and in-memory caches
    // For kind 0 (profile) events, also cache individually by pubkey
    const profileEvents = finalEvents.filter(e => e.kind === 0);
    for (const profileEvent of profileEvents) {
      eventCache.setProfile(profileEvent.pubkey, profileEvent);
      // Also cache in persistent cache if available
      if (persistentCache) {
        persistentCache.setProfile(profileEvent.pubkey, profileEvent).catch(err => {
          logger.debug({ error: err, pubkey: profileEvent.pubkey }, 'Failed to cache profile');
        });
      }
    }
    
    // Cache the merged results (skip cache for search queries)
    const hasSearchQuery = filters.some(f => f.search && f.search.trim().length > 0);
    if (!hasSearchQuery) {
      if (finalEvents.length > 0 || results.some(r => r.status === 'fulfilled')) {
        // Cache successful fetches for 5 minutes, empty results for 1 minute
        const ttl = finalEvents.length > 0 ? 5 * 60 * 1000 : 60 * 1000;
        
        // Update in-memory cache
        eventCache.set(filters, finalEvents, ttl);
        
        // Update persistent cache (async, don't wait) - only in browser
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
      
      // Fetch from all relays in parallel, bypassing cache to avoid recursion
      const promises = this.relays.map(relay => this.fetchFromRelay(relay, [{
        kinds: [KIND.DELETION_REQUEST],
        since,
        limit: 100
      }]));
      const results = await Promise.allSettled(promises);
      
      for (const result of results) {
        if (result.status === 'fulfilled') {
          events.push(...result.value);
        }
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
        // Process deletions in in-memory cache
        eventCache.processDeletionEvents(deletionEvents);

        // Process deletions in persistent cache
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

  private async fetchFromRelay(relay: string, filters: NostrFilter[]): Promise<NostrEvent[]> {
    // Ensure WebSocket polyfill is initialized
    await initializeWebSocketPolyfill();
    
    const self = this;
    return new Promise((resolve) => {
      let ws: WebSocket | null = null;
      const events: NostrEvent[] = [];
      let resolved = false;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      let connectionTimeoutId: ReturnType<typeof setTimeout> | null = null;
      let authHandled = false;
      
      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        if (connectionTimeoutId) {
          clearTimeout(connectionTimeoutId);
          connectionTimeoutId = null;
        }
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
          try {
            ws.close();
          } catch {
            // Ignore errors during cleanup
          }
        }
      };

      const resolveOnce = (value: NostrEvent[] = []) => {
        if (!resolved) {
          resolved = true;
          cleanup();
          resolve(value);
        }
      };
      
      let authPromise: Promise<boolean> | null = null;
      
      // Create WebSocket connection (with Tor support if needed)
      createWebSocketWithTor(relay).then(websocket => {
        ws = websocket;
        setupWebSocketHandlers();
      }).catch(error => {
        // Connection failed immediately
        resolveOnce([]);
      });
      
      function setupWebSocketHandlers() {
        if (!ws) return;
        
        // Connection timeout - if we can't connect within 3 seconds, give up
        connectionTimeoutId = setTimeout(() => {
          if (!resolved && ws && ws.readyState !== WebSocket.OPEN) {
            resolveOnce([]);
          }
        }, 3000);
        
        ws.onopen = () => {
        if (connectionTimeoutId) {
          clearTimeout(connectionTimeoutId);
          connectionTimeoutId = null;
        }
        // Connection opened, wait for AUTH challenge or proceed
        // If no AUTH challenge comes within 1 second, send REQ
        setTimeout(() => {
          if (!authHandled && ws && ws.readyState === WebSocket.OPEN) {
            try {
              ws.send(JSON.stringify(['REQ', 'sub', ...filters]));
            } catch {
              // Connection might have closed
              resolveOnce(events);
            }
          }
        }, 1000);
      };
      
      ws.onmessage = async (event: MessageEvent) => {
        try {
          const message = JSON.parse(event.data);
          
          // Handle AUTH challenge
          if (message[0] === 'AUTH' && message[1] && !authHandled) {
            authHandled = true;
            authPromise = self.handleAuthChallenge(ws!, relay, message[1]);
            const authenticated = await authPromise;
            // After authentication, send the REQ
            if (ws && ws.readyState === WebSocket.OPEN) {
              try {
                ws.send(JSON.stringify(['REQ', 'sub', ...filters]));
              } catch {
                resolveOnce(events);
              }
            }
            return;
          }
          
          // Wait for auth to complete before processing other messages
          if (authPromise) {
            await authPromise;
          }
          
          if (message[0] === 'EVENT') {
            events.push(message[2]);
          } else if (message[0] === 'EOSE') {
            resolveOnce(events);
          }
        } catch (error) {
          // Ignore parse errors, continue receiving events
        }
      };
      
      ws.onerror = () => {
        // Silently handle connection errors - some relays may be down
        // Don't log or reject, just resolve with empty results
        if (!resolved) {
          resolveOnce([]);
        }
      };

      ws.onclose = () => {
        // If we haven't resolved yet, resolve with what we have
        if (!resolved) {
          resolveOnce(events);
        }
      };
      
        // Overall timeout - resolve with what we have after 8 seconds
        timeoutId = setTimeout(() => {
          resolveOnce(events);
        }, 8000);
      }
    });
  }

  async publishEvent(event: NostrEvent, relays?: string[]): Promise<{ success: string[]; failed: Array<{ relay: string; error: string }> }> {
    const targetRelays = relays || this.relays;
    const success: string[] = [];
    const failed: Array<{ relay: string; error: string }> = [];
    
    const promises = targetRelays.map(async (relay) => {
      try {
        await this.publishToRelay(relay, event);
        success.push(relay);
      } catch (error) {
        failed.push({ relay, error: String(error) });
      }
    });
    
    await Promise.allSettled(promises);
    
    // Invalidate cache for events from this pubkey (new event published)
    // This ensures fresh data on next fetch
    if (success.length > 0) {
      eventCache.invalidatePubkey(event.pubkey);
      
      // Also invalidate persistent cache
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

  private async publishToRelay(relay: string, nostrEvent: NostrEvent): Promise<void> {
    // Ensure WebSocket polyfill is initialized
    await initializeWebSocketPolyfill();
    
    const self = this;
    return new Promise((resolve, reject) => {
      let ws: WebSocket | null = null;
      let resolved = false;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      let connectionTimeoutId: ReturnType<typeof setTimeout> | null = null;
      let authHandled = false;
      
      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        if (connectionTimeoutId) {
          clearTimeout(connectionTimeoutId);
          connectionTimeoutId = null;
        }
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
          try {
            ws.close();
          } catch {
            // Ignore errors during cleanup
          }
        }
      };

      const resolveOnce = () => {
        if (!resolved) {
          resolved = true;
          cleanup();
          resolve();
        }
      };

      const rejectOnce = (error: Error) => {
        if (!resolved) {
          resolved = true;
          cleanup();
          reject(error);
        }
      };
      
      let authPromise: Promise<boolean> | null = null;
      
      // Create WebSocket connection (with Tor support if needed)
      createWebSocketWithTor(relay).then(websocket => {
        ws = websocket;
        setupWebSocketHandlers();
      }).catch(error => {
        rejectOnce(new Error(`Failed to create WebSocket connection to ${relay}: ${error}`));
      });
      
      function setupWebSocketHandlers() {
        if (!ws) return;
        
        // Connection timeout - if we can't connect within 3 seconds, reject
        connectionTimeoutId = setTimeout(() => {
          if (!resolved && ws && ws.readyState !== WebSocket.OPEN) {
            rejectOnce(new Error(`Connection timeout for ${relay}`));
          }
        }, 3000);
        
        ws.onopen = () => {
        if (connectionTimeoutId) {
          clearTimeout(connectionTimeoutId);
          connectionTimeoutId = null;
        }
        // Connection opened, wait for AUTH challenge or proceed
        // If no AUTH challenge comes within 1 second, send EVENT
        setTimeout(() => {
          if (!authHandled && ws && ws.readyState === WebSocket.OPEN) {
            try {
              ws.send(JSON.stringify(['EVENT', nostrEvent]));
            } catch (error) {
              rejectOnce(error instanceof Error ? error : new Error(String(error)));
            }
          }
        }, 1000);
      };
      
      ws.onmessage = async (event: MessageEvent) => {
        try {
          const message = JSON.parse(event.data);
          
          // Handle AUTH challenge
          if (message[0] === 'AUTH' && message[1] && !authHandled) {
            authHandled = true;
            authPromise = self.handleAuthChallenge(ws!, relay, message[1]);
            await authPromise;
            // After authentication attempt, send the EVENT
            if (ws && ws.readyState === WebSocket.OPEN) {
              try {
                ws.send(JSON.stringify(['EVENT', nostrEvent]));
              } catch (error) {
                rejectOnce(error instanceof Error ? error : new Error(String(error)));
              }
            }
            return;
          }
          
          // Wait for auth to complete before processing other messages
          if (authPromise) {
            await authPromise;
          }
          
          if (message[0] === 'OK' && message[1] === nostrEvent.id) {
            if (message[2] === true) {
              resolveOnce();
            } else {
              rejectOnce(new Error(message[3] || 'Publish rejected'));
            }
          }
        } catch (error) {
          // Ignore parse errors, continue waiting for OK message
        }
      };
      
      ws.onerror = () => {
        // Silently handle connection errors - reject after a short delay
        // to allow connection to attempt
        if (!resolved) {
          setTimeout(() => {
            if (!resolved) {
              rejectOnce(new Error(`Connection failed for ${relay}`));
            }
          }, 100);
        }
      };

      ws.onclose = () => {
        // If we haven't resolved yet, it's an unexpected close
        if (!resolved) {
          rejectOnce(new Error('WebSocket closed unexpectedly'));
        }
      };
      
        timeoutId = setTimeout(() => {
          rejectOnce(new Error('Publish timeout'));
        }, 10000);
      }
    });
  }
}
