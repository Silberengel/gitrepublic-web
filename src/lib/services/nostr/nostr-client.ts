/**
 * Nostr client for fetching and publishing events
 */

import type { NostrEvent, NostrFilter } from '../../types/nostr.js';
import logger from '../logger.js';
import { isNIP07Available, getPublicKeyWithNIP07, signEventWithNIP07 } from './nip07-signer.js';

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

export class NostrClient {
  private relays: string[] = [];
  private authenticatedRelays: Set<string> = new Set();

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
    const events: NostrEvent[] = [];
    
    // Fetch from all relays in parallel
    const promises = this.relays.map(relay => this.fetchFromRelay(relay, filters));
    const results = await Promise.allSettled(promises);
    
    for (const result of results) {
      if (result.status === 'fulfilled') {
        events.push(...result.value);
      }
    }
    
    // Deduplicate by event ID
    const uniqueEvents = new Map<string, NostrEvent>();
    for (const event of events) {
      if (!uniqueEvents.has(event.id) || event.created_at > uniqueEvents.get(event.id)!.created_at) {
        uniqueEvents.set(event.id, event);
      }
    }
    
    return Array.from(uniqueEvents.values());
  }

  private async fetchFromRelay(relay: string, filters: NostrFilter[]): Promise<NostrEvent[]> {
    // Ensure WebSocket polyfill is initialized
    await initializeWebSocketPolyfill();
    
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
      
      try {
        ws = new WebSocket(relay);
      } catch (error) {
        // Connection failed immediately
        resolveOnce([]);
        return;
      }
      
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
            authPromise = this.handleAuthChallenge(ws!, relay, message[1]);
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
    
    return { success, failed };
  }

  private async publishToRelay(relay: string, nostrEvent: NostrEvent): Promise<void> {
    // Ensure WebSocket polyfill is initialized
    await initializeWebSocketPolyfill();
    
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
      
      try {
        ws = new WebSocket(relay);
      } catch (error) {
        rejectOnce(new Error(`Failed to create WebSocket connection to ${relay}`));
        return;
      }
      
      // Connection timeout - if we can't connect within 3 seconds, reject
      connectionTimeoutId = setTimeout(() => {
        if (!resolved && ws && ws.readyState !== WebSocket.OPEN) {
          rejectOnce(new Error(`Connection timeout for ${relay}`));
        }
      }, 3000);
      
      let authPromise: Promise<boolean> | null = null;
      
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
            authPromise = this.handleAuthChallenge(ws!, relay, message[1]);
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
    });
  }
}
