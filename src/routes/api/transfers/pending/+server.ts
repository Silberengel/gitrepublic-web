/**
 * API endpoint to check for pending ownership transfers for the logged-in user
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { nostrClient } from '$lib/services/service-registry.js';
import { DEFAULT_NOSTR_RELAYS, DEFAULT_NOSTR_SEARCH_RELAYS, combineRelays } from '$lib/config.js';
import { KIND } from '$lib/types/nostr.js';
import type { NostrEvent } from '$lib/types/nostr.js';
import { verifyEvent } from 'nostr-tools';
import { getUserRelays } from '$lib/services/nostr/user-relays.js';
import logger from '$lib/services/logger.js';

export const GET: RequestHandler = async ({ request }) => {
  const userPubkeyHex = request.headers.get('X-User-Pubkey');
  
  if (!userPubkeyHex) {
    return json({ pendingTransfers: [] });
  }

  try {
    // Get user's relays for comprehensive search
    const { inbox, outbox } = await getUserRelays(userPubkeyHex, nostrClient);
    // Combine user relays with default and search relays
    const userRelays = [...inbox, ...outbox];
    const allRelays = [...new Set([...userRelays, ...DEFAULT_NOSTR_RELAYS, ...DEFAULT_NOSTR_SEARCH_RELAYS])];
    
    // Create a new client with all relays for comprehensive search
    const { NostrClient } = await import('$lib/services/nostr/nostr-client.js');
    const searchClient = new NostrClient(allRelays);

    // Search for transfer events where this user is the new owner (p tag)
    const transferEvents = await searchClient.fetchEvents([
      {
        kinds: [KIND.OWNERSHIP_TRANSFER],
        '#p': [userPubkeyHex],
        limit: 100
      }
    ]);

    // Filter for valid, non-self-transfer events that haven't been completed
    const pendingTransfers: Array<{
      eventId: string;
      fromPubkey: string;
      toPubkey: string;
      repoTag: string;
      repoName: string;
      originalOwner: string;
      timestamp: number;
      createdAt: string;
      event: NostrEvent;
    }> = [];

    for (const event of transferEvents) {
      // Verify event signature
      if (!verifyEvent(event)) {
        continue;
      }

      // Skip self-transfers
      if (event.pubkey === userPubkeyHex) {
        continue;
      }

      // Extract repo tag
      const aTag = event.tags.find(t => t[0] === 'a');
      if (!aTag || !aTag[1]) {
        continue;
      }

      // Parse repo tag: kind:pubkey:repo
      const repoTag = aTag[1];
      const parts = repoTag.split(':');
      if (parts.length < 3) {
        continue;
      }

      const originalOwner = parts[1];
      const repoName = parts[2];

      // Extract new owner (p tag)
      const pTag = event.tags.find(t => t[0] === 'p');
      if (!pTag || !pTag[1] || pTag[1] !== userPubkeyHex) {
        continue;
      }

      // Check if transfer is already completed by checking for a newer repo announcement from the new owner
      // This is a simple check - if there's a newer announcement from the new owner for this repo, transfer is complete
      const newerAnnouncements = await searchClient.fetchEvents([
        {
          kinds: [KIND.REPO_ANNOUNCEMENT],
          authors: [userPubkeyHex],
          '#d': [repoName],
          since: event.created_at,
          limit: 1
        }
      ]);

      // If there's a newer announcement from the new owner, transfer is complete
      if (newerAnnouncements.length > 0) {
        continue;
      }

      pendingTransfers.push({
        eventId: event.id,
        fromPubkey: event.pubkey,
        toPubkey: userPubkeyHex,
        repoTag,
        repoName,
        originalOwner,
        timestamp: event.created_at,
        createdAt: new Date(event.created_at * 1000).toISOString(),
        event
      });
    }

    // Sort by timestamp (newest first)
    pendingTransfers.sort((a, b) => b.timestamp - a.timestamp);

    return json({ pendingTransfers });
  } catch (err) {
    logger.error({ error: err, userPubkeyHex }, 'Error checking for pending transfers');
    return json({ pendingTransfers: [], error: 'Failed to check for pending transfers' });
  }
};
