/**
 * Nostr client for fetching and publishing events
 */

import type { NostrEvent, NostrFilter } from '../../types/nostr.js';
import { createRequire } from 'module';
import logger from '../logger.js';

// Polyfill WebSocket for Node.js environments (lazy initialization)
let wsPolyfillInitialized = false;
function initializeWebSocketPolyfill() {
  if (wsPolyfillInitialized) return;
  if (typeof global === 'undefined' || typeof global.WebSocket !== 'undefined') {
    wsPolyfillInitialized = true;
    return;
  }
  
  try {
    // Use createRequire for ES modules compatibility
    const requireFunc = createRequire(import.meta.url);
    const WebSocketImpl = requireFunc('ws');
    global.WebSocket = WebSocketImpl as any;
    wsPolyfillInitialized = true;
  } catch {
    // ws package not available, will fail at runtime in Node.js
    logger.warn('WebSocket polyfill not available. Install "ws" package for Node.js support.');
    wsPolyfillInitialized = true; // Mark as initialized to avoid repeated warnings
  }
}

// Initialize on module load if in Node.js
if (typeof process !== 'undefined' && process.versions?.node) {
  initializeWebSocketPolyfill();
}

export class NostrClient {
  private relays: string[] = [];

  constructor(relays: string[]) {
    this.relays = relays;
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
    initializeWebSocketPolyfill();
    
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(relay);
      const events: NostrEvent[] = [];
      let resolved = false;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      
      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          try {
            ws.close();
          } catch {
            // Ignore errors during cleanup
          }
        }
      };

      const resolveOnce = (value: NostrEvent[]) => {
        if (!resolved) {
          resolved = true;
          cleanup();
          resolve(value);
        }
      };

      const rejectOnce = (error: Error) => {
        if (!resolved) {
          resolved = true;
          cleanup();
          reject(error);
        }
      };
      
      ws.onopen = () => {
        try {
          ws.send(JSON.stringify(['REQ', 'sub', ...filters]));
        } catch (error) {
          rejectOnce(error instanceof Error ? error : new Error(String(error)));
        }
      };
      
      ws.onmessage = (event: MessageEvent) => {
        try {
          const message = JSON.parse(event.data);
          
          if (message[0] === 'EVENT') {
            events.push(message[2]);
          } else if (message[0] === 'EOSE') {
            resolveOnce(events);
          }
        } catch (error) {
          // Ignore parse errors, continue receiving events
        }
      };
      
      ws.onerror = (error) => {
        rejectOnce(new Error(`WebSocket error for ${relay}: ${error}`));
      };

      ws.onclose = () => {
        // If we haven't resolved yet, resolve with what we have
        if (!resolved) {
          resolveOnce(events);
        }
      };
      
      timeoutId = setTimeout(() => {
        resolveOnce(events);
      }, 5000);
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
    initializeWebSocketPolyfill();
    
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(relay);
      let resolved = false;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      
      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
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
      
      ws.onopen = () => {
        try {
          ws.send(JSON.stringify(['EVENT', nostrEvent]));
        } catch (error) {
          rejectOnce(error instanceof Error ? error : new Error(String(error)));
        }
      };
      
      ws.onmessage = (event: MessageEvent) => {
        try {
          const message = JSON.parse(event.data);
          
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
      
      ws.onerror = (error) => {
        rejectOnce(new Error(`WebSocket error for ${relay}: ${error}`));
      };

      ws.onclose = () => {
        // If we haven't resolved yet, it's an unexpected close
        if (!resolved) {
          rejectOnce(new Error('WebSocket closed unexpectedly'));
        }
      };
      
      timeoutId = setTimeout(() => {
        rejectOnce(new Error('Publish timeout'));
      }, 5000);
    });
  }
}
