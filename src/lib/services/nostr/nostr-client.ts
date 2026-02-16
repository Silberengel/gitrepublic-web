/**
 * Nostr client for fetching and publishing events
 */

import type { NostrEvent, NostrFilter } from '../../types/nostr.js';

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
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(relay);
      const events: NostrEvent[] = [];
      
      ws.onopen = () => {
        ws.send(JSON.stringify(['REQ', 'sub', ...filters]));
      };
      
      ws.onmessage = (event: MessageEvent) => {
        const message = JSON.parse(event.data);
        
        if (message[0] === 'EVENT') {
          events.push(message[2]);
        } else if (message[0] === 'EOSE') {
          ws.close();
          resolve(events);
        }
      };
      
      ws.onerror = (error) => {
        ws.close();
        reject(error);
      };
      
      setTimeout(() => {
        ws.close();
        resolve(events);
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
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(relay);
      
      ws.onopen = () => {
        ws.send(JSON.stringify(['EVENT', nostrEvent]));
      };
      
      ws.onmessage = (event: MessageEvent) => {
        const message = JSON.parse(event.data);
        
        if (message[0] === 'OK' && message[1] === nostrEvent.id) {
          if (message[2] === true) {
            ws.close();
            resolve();
          } else {
            ws.close();
            reject(new Error(message[3] || 'Publish rejected'));
          }
        }
      };
      
      ws.onerror = (error) => {
        ws.close();
        reject(error);
      };
      
      setTimeout(() => {
        ws.close();
        reject(new Error('Timeout'));
      }, 5000);
    });
  }
}
