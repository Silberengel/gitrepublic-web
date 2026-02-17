/**
 * Service for fetching user's preferred relays from their inbox/outbox
 */

import { NostrClient } from './nostr-client.js';
import type { NostrEvent } from '../../types/nostr.js';
import { KIND } from '../../types/nostr.js';
import logger from '../logger.js';
import { truncatePubkey } from '../../utils/security.js';

export async function getUserRelays(
  pubkey: string,
  nostrClient: NostrClient
): Promise<{ inbox: string[]; outbox: string[] }> {
  const inbox: string[] = [];
  const outbox: string[] = [];

  try {
    // Fetch kind 10002 (relay list) - get multiple to find the newest
    const relayListEvents = await nostrClient.fetchEvents([
      {
        kinds: [KIND.RELAY_LIST],
        authors: [pubkey],
        limit: 10 // Get multiple to ensure we find the newest
      }
    ]);

    if (relayListEvents.length > 0) {
      // Sort by created_at descending to get the newest event first
      relayListEvents.sort((a, b) => b.created_at - a.created_at);
      const event = relayListEvents[0];
      for (const tag of event.tags) {
        if (tag[0] === 'relay' && tag[1]) {
          const relay = tag[1];
          const read = tag[2] !== 'write';
          const write = tag[2] !== 'read';

          if (read) inbox.push(relay);
          if (write) outbox.push(relay);
        }
      }
    }

    // Fallback to kind 3 (contacts) for older clients
    if (inbox.length === 0 && outbox.length === 0) {
      const contactEvents = await nostrClient.fetchEvents([
        {
          kinds: [KIND.CONTACT_LIST],
          authors: [pubkey],
          limit: 1
        }
      ]);

      if (contactEvents.length > 0) {
        const event = contactEvents[0];
        // Extract relays from content (JSON) or tags
        try {
          const content = JSON.parse(event.content);
          if (content.relays && Array.isArray(content.relays)) {
            inbox.push(...content.relays);
            outbox.push(...content.relays);
          }
        } catch {
          // Not JSON, check tags
          for (const tag of event.tags) {
            if (tag[0] === 'relay' && tag[1]) {
              inbox.push(tag[1]);
              outbox.push(tag[1]);
            }
          }
        }
      }
    }
  } catch (error) {
    logger.error({ error, pubkey: truncatePubkey(pubkey) }, 'Failed to fetch user relays');
  }

  return { inbox, outbox };
}