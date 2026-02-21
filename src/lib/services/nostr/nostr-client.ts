/**
 * Nostr client for fetching and publishing events
 */

import type { NostrEvent, NostrFilter } from '../../types/nostr.js';
import logger from '../logger.js';
import { isNIP07Available, getPublicKeyWithNIP07, signEventWithNIP07 } from './nip07-signer.js';
import { shouldUseTor, getTorProxy } from '../../utils/tor.js';
// Removed separate in-memory cache - persistent cache now has built-in memory layer
import { KIND } from '../../types/nostr.js';

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

// Connection pool for WebSocket connections
interface RelayConnection {
  ws: WebSocket;
  lastUsed: number;
  pendingRequests: number;
  reconnectAttempts: number;
  messageHandlers: Map<string, (message: any) => void>; // subscription ID -> handler
  nextSubscriptionId: number;
}

export class NostrClient {
  private relays: string[] = [];
  private authenticatedRelays: Set<string> = new Set();
  private processingDeletions: boolean = false; // Guard to prevent recursive deletion processing
  private connectionPool: Map<string, RelayConnection> = new Map();
  private readonly CONNECTION_TIMEOUT = 30000; // Close idle connections after 30 seconds
  private readonly MAX_RECONNECT_ATTEMPTS = 3;
  private readonly RECONNECT_DELAY = 2000; // 2 seconds between reconnect attempts
  private connectionAttempts: Map<string, { count: number; lastAttempt: number }> = new Map();
  private readonly MAX_CONCURRENT_CONNECTIONS = 3; // Max concurrent connections per relay
  private readonly CONNECTION_BACKOFF_BASE = 1000; // Base backoff in ms

  constructor(relays: string[]) {
    this.relays = relays;
    // Clean up idle connections periodically
    if (typeof window !== 'undefined') {
      setInterval(() => this.cleanupIdleConnections(), 10000); // Check every 10 seconds
    }
  }

  /**
   * Clean up idle connections that haven't been used recently
   */
  private cleanupIdleConnections(): void {
    const now = Date.now();
    for (const [relay, conn] of this.connectionPool.entries()) {
      // Close connections that are idle and have no pending requests
      if (conn.pendingRequests === 0 && 
          now - conn.lastUsed > this.CONNECTION_TIMEOUT &&
          (conn.ws.readyState === WebSocket.OPEN || conn.ws.readyState === WebSocket.CLOSED)) {
        try {
          if (conn.ws.readyState === WebSocket.OPEN) {
            conn.ws.close();
          }
        } catch {
          // Ignore errors
        }
        this.connectionPool.delete(relay);
      }
    }
  }

  /**
   * Get or create a WebSocket connection to a relay
   */
  private async getConnection(relay: string): Promise<WebSocket | null> {
    const existing = this.connectionPool.get(relay);
    
    // Reuse existing connection if it's open
    if (existing && existing.ws.readyState === WebSocket.OPEN) {
      existing.lastUsed = Date.now();
      existing.pendingRequests++;
      return existing.ws;
    }
    
    // Check connection attempt throttling
    const attemptInfo = this.connectionAttempts.get(relay) || { count: 0, lastAttempt: 0 };
    const now = Date.now();
    const timeSinceLastAttempt = now - attemptInfo.lastAttempt;
    
    // If we've had too many recent failures, apply exponential backoff
    if (attemptInfo.count > 0) {
      const backoffTime = this.CONNECTION_BACKOFF_BASE * Math.pow(2, Math.min(attemptInfo.count - 1, 5));
      if (timeSinceLastAttempt < backoffTime) {
        logger.debug({ relay, backoffTime, timeSinceLastAttempt }, 'Throttling connection attempt');
        return null; // Don't attempt connection yet
      }
    }
    
    // Check if we have too many concurrent connections to this relay
    const openConnections = Array.from(this.connectionPool.values())
      .filter(c => c.ws === existing?.ws || (c.ws.readyState === WebSocket.OPEN || c.ws.readyState === WebSocket.CONNECTING))
      .length;
    
    if (openConnections >= this.MAX_CONCURRENT_CONNECTIONS) {
      logger.debug({ relay, openConnections }, 'Too many concurrent connections, skipping');
      return null;
    }
    
    // Remove dead connection
    if (existing) {
      this.connectionPool.delete(relay);
      try {
        if (existing.ws.readyState !== WebSocket.CLOSED) {
          existing.ws.close();
        }
      } catch {
        // Ignore errors
      }
    }

    // Update attempt tracking
    this.connectionAttempts.set(relay, { count: attemptInfo.count + 1, lastAttempt: now });

    // Create new connection
    try {
      const ws = await createWebSocketWithTor(relay);
      const conn: RelayConnection = {
        ws,
        lastUsed: Date.now(),
        pendingRequests: 1,
        reconnectAttempts: 0,
        messageHandlers: new Map(),
        nextSubscriptionId: 1
      };
      
      // Set up shared message handler for routing
      ws.onmessage = (event: MessageEvent) => {
        try {
          const message = JSON.parse(event.data);
          
          // Route to appropriate handler based on message type
          if (message[0] === 'EVENT' && message[1]) {
            // message[1] is the subscription ID
            const handler = conn.messageHandlers.get(message[1]);
            if (handler) {
              handler(message);
            }
          } else if (message[0] === 'EOSE' && message[1]) {
            // message[1] is the subscription ID
            const handler = conn.messageHandlers.get(message[1]);
            if (handler) {
              handler(message);
            }
          } else if (message[0] === 'AUTH') {
            // AUTH challenge - broadcast to all handlers (they'll handle it)
            for (const handler of conn.messageHandlers.values()) {
              handler(message);
            }
          } else if (message[0] === 'OK' && message[1] === 'auth') {
            // AUTH response - broadcast to all handlers
            for (const handler of conn.messageHandlers.values()) {
              handler(message);
            }
          }
        } catch (error) {
          // Ignore parse errors
        }
      };
      
      // Handle connection close/error
      ws.onclose = () => {
        // Remove from pool when closed
        const poolConn = this.connectionPool.get(relay);
        if (poolConn && poolConn.ws === ws) {
          this.connectionPool.delete(relay);
        }
      };
      
      ws.onerror = () => {
        // Remove from pool on error
        const poolConn = this.connectionPool.get(relay);
        if (poolConn && poolConn.ws === ws) {
          this.connectionPool.delete(relay);
        }
      };
      
      this.connectionPool.set(relay, conn);
      
      // Reset attempt count on successful connection
      ws.onopen = () => {
        this.connectionAttempts.set(relay, { count: 0, lastAttempt: Date.now() });
      };
      
      return ws;
    } catch (error) {
      logger.debug({ error, relay }, 'Failed to create WebSocket connection');
      return null;
    }
  }

  /**
   * Release a connection (decrement pending requests counter)
   */
  private releaseConnection(relay: string): void {
    const conn = this.connectionPool.get(relay);
    if (conn) {
      conn.pendingRequests = Math.max(0, conn.pendingRequests - 1);
      conn.lastUsed = Date.now();
    }
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
    
    // Remove events that should be deleted
    for (const eventId of eventsToDelete) {
      eventMap.delete(eventId); // Remove by ID if it was keyed by ID
      // Also remove from map if it's keyed by deduplication key
      for (const [key, event] of eventMap.entries()) {
        if (event.id === eventId) {
          eventMap.delete(key);
          break;
        }
      }
    }
    
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
      if (finalEvents.length > 0 || results.some(r => r.status === 'fulfilled')) {
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
      let isNewConnection = false;
      
      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        if (connectionTimeoutId) {
          clearTimeout(connectionTimeoutId);
          connectionTimeoutId = null;
        }
        // Only close if it's a new connection we created (not from pool)
        // Pool connections are managed separately
        if (isNewConnection && ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
          try {
            ws.close();
          } catch {
            // Ignore errors during cleanup
          }
        } else {
          // Release connection back to pool
          self.releaseConnection(relay);
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
      
      // Get connection from pool or create new one
      this.getConnection(relay).then(websocket => {
        if (!websocket) {
          resolveOnce([]);
          return;
        }
        ws = websocket;
        isNewConnection = false; // From pool
        setupWebSocketHandlers();
      }).catch(error => {
        // Connection failed, try creating new one
        createWebSocketWithTor(relay).then(websocket => {
          ws = websocket;
          isNewConnection = true; // New connection
          setupWebSocketHandlers();
        }).catch(err => {
          // Connection failed immediately
          resolveOnce([]);
        });
      });
      
      function setupWebSocketHandlers() {
        if (!ws) return;
        
        const conn = self.connectionPool.get(relay);
        if (!conn) {
          resolveOnce([]);
          return;
        }
        
        // Get unique subscription ID for this request
        const subscriptionId = `sub${conn.nextSubscriptionId++}`;
        
        // Connection timeout - if we can't connect within 3 seconds, give up
        connectionTimeoutId = setTimeout(() => {
          if (!resolved && ws && ws.readyState !== WebSocket.OPEN) {
            conn.messageHandlers.delete(subscriptionId);
            resolveOnce([]);
          }
        }, 3000);
        
        // Set up message handler for this subscription
        const messageHandler = async (message: any) => {
          try {
            // Handle AUTH challenge
            if (message[0] === 'AUTH' && message[1] && !authHandled) {
              authHandled = true;
              authPromise = self.handleAuthChallenge(ws!, relay, message[1]);
              const authenticated = await authPromise;
              // After authentication, send the REQ
              if (ws && ws.readyState === WebSocket.OPEN) {
                try {
                  ws.send(JSON.stringify(['REQ', subscriptionId, ...filters]));
                } catch {
                  conn.messageHandlers.delete(subscriptionId);
                  resolveOnce(events);
                }
              }
              return;
            }
            
            // Handle AUTH OK response
            if (message[0] === 'OK' && message[1] === 'auth' && ws) {
              // AUTH completed, send REQ if not already sent
              if (ws.readyState === WebSocket.OPEN && !authHandled) {
                setTimeout(() => {
                  if (ws && ws.readyState === WebSocket.OPEN) {
                    try {
                      ws.send(JSON.stringify(['REQ', subscriptionId, ...filters]));
                    } catch {
                      conn.messageHandlers.delete(subscriptionId);
                      resolveOnce(events);
                    }
                  }
                }, 100);
              }
              return;
            }
            
            // Wait for auth to complete before processing other messages
            if (authPromise) {
              await authPromise;
            }
            
            // Only process messages for this subscription
            if (message[1] === subscriptionId) {
              if (message[0] === 'EVENT') {
                events.push(message[2]);
              } else if (message[0] === 'EOSE') {
                conn.messageHandlers.delete(subscriptionId);
                resolveOnce(events);
              }
            }
          } catch (error) {
            // Ignore parse errors, continue receiving events
          }
        };
        
        conn.messageHandlers.set(subscriptionId, messageHandler);
        
        // If connection is already open, send REQ immediately
        if (ws.readyState === WebSocket.OPEN) {
          // Wait a bit for AUTH challenge if needed
          setTimeout(() => {
            if (!authHandled && ws && ws.readyState === WebSocket.OPEN) {
              try {
                ws.send(JSON.stringify(['REQ', subscriptionId, ...filters]));
              } catch {
                conn.messageHandlers.delete(subscriptionId);
                resolveOnce(events);
              }
            }
          }, 1000);
        } else {
          // Wait for connection to open
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
                  ws.send(JSON.stringify(['REQ', subscriptionId, ...filters]));
                } catch {
                  conn.messageHandlers.delete(subscriptionId);
                  resolveOnce(events);
                }
              }
            }, 1000);
          };
        }
        
        // Error and close handlers are set on the connection itself
        // But we need to clean up our handler
        if (ws) {
          const wsRef = ws; // Capture for closure
          const originalOnError = ws.onerror;
          ws.onerror = () => {
            conn.messageHandlers.delete(subscriptionId);
            if (originalOnError) {
              // Create an Event-like object for Node.js compatibility
              const errorEvent = typeof Event !== 'undefined' 
                ? new Event('error')
                : ({ type: 'error', target: wsRef } as unknown as Event);
              originalOnError.call(wsRef, errorEvent);
            }
            if (!resolved) {
              resolveOnce([]);
            }
          };

          const originalOnClose = ws.onclose;
          ws.onclose = () => {
            conn.messageHandlers.delete(subscriptionId);
            if (originalOnClose) {
              // Create a CloseEvent-like object for Node.js compatibility
              const closeEvent = typeof CloseEvent !== 'undefined' 
                ? new CloseEvent('close')
                : ({ type: 'close', code: 1000, reason: '', wasClean: true } as unknown as CloseEvent);
              originalOnClose.call(wsRef, closeEvent);
            }
            // If we haven't resolved yet, resolve with what we have
            if (!resolved) {
              resolveOnce(events);
            }
          };
        }
      
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
