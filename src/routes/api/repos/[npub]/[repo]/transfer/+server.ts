/**
 * API endpoint for transferring repository ownership
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { OwnershipTransferService } from '$lib/services/nostr/ownership-transfer-service.js';
import { NostrClient } from '$lib/services/nostr/nostr-client.js';
import { DEFAULT_NOSTR_RELAYS, combineRelays } from '$lib/config.js';
import { KIND } from '$lib/types/nostr.js';
import { nip19 } from 'nostr-tools';
import { verifyEvent } from 'nostr-tools';
import type { NostrEvent } from '$lib/types/nostr.js';
import { getUserRelays } from '$lib/services/nostr/user-relays.js';

const ownershipTransferService = new OwnershipTransferService(DEFAULT_NOSTR_RELAYS);
const nostrClient = new NostrClient(DEFAULT_NOSTR_RELAYS);

/**
 * GET - Get current owner and transfer history
 */
export const GET: RequestHandler = async ({ params }) => {
  const { npub, repo } = params;

  if (!npub || !repo) {
    return error(400, 'Missing npub or repo parameter');
  }

  try {
    // Decode npub to get pubkey
    let originalOwnerPubkey: string;
    try {
      const decoded = nip19.decode(npub);
      if (decoded.type === 'npub') {
        originalOwnerPubkey = decoded.data as string;
      } else {
        return error(400, 'Invalid npub format');
      }
    } catch {
      return error(400, 'Invalid npub format');
    }

    // Get current owner (may be different if transferred)
    const currentOwner = await ownershipTransferService.getCurrentOwner(originalOwnerPubkey, repo);

    // Fetch transfer events for history
    const repoTag = `30617:${originalOwnerPubkey}:${repo}`;
    const transferEvents = await nostrClient.fetchEvents([
      {
        kinds: [KIND.OWNERSHIP_TRANSFER],
        '#a': [repoTag],
        limit: 100
      }
    ]);

    // Sort by created_at descending
    transferEvents.sort((a, b) => b.created_at - a.created_at);

    return json({
      originalOwner: originalOwnerPubkey,
      currentOwner,
      transferred: currentOwner !== originalOwnerPubkey,
      transfers: transferEvents.map(event => {
        const pTag = event.tags.find(t => t[0] === 'p');
        return {
          eventId: event.id,
          from: event.pubkey,
          to: pTag?.[1] || 'unknown',
          timestamp: event.created_at,
          createdAt: new Date(event.created_at * 1000).toISOString()
        };
      })
    });
  } catch (err) {
    console.error('Error fetching ownership info:', err);
    return error(500, err instanceof Error ? err.message : 'Failed to fetch ownership info');
  }
};

/**
 * POST - Initiate ownership transfer
 * Requires a pre-signed NIP-98 authenticated event from the current owner
 */
export const POST: RequestHandler = async ({ params, request }) => {
  const { npub, repo } = params;

  if (!npub || !repo) {
    return error(400, 'Missing npub or repo parameter');
  }

  try {
    const body = await request.json();
    const { transferEvent, userPubkey } = body;

    if (!transferEvent || !userPubkey) {
      return error(400, 'Missing transferEvent or userPubkey in request body');
    }

    // Verify the event is properly signed
    if (!transferEvent.sig || !transferEvent.id) {
      return error(400, 'Invalid event: missing signature or ID');
    }

    if (!verifyEvent(transferEvent)) {
      return error(400, 'Invalid event signature');
    }

    // Decode npub to get original owner pubkey
    let originalOwnerPubkey: string;
    try {
      const decoded = nip19.decode(npub);
      if (decoded.type === 'npub') {
        originalOwnerPubkey = decoded.data as string;
      } else {
        return error(400, 'Invalid npub format');
      }
    } catch {
      return error(400, 'Invalid npub format');
    }

    // Verify user is the current owner
    const canTransfer = await ownershipTransferService.canTransfer(
      userPubkey,
      originalOwnerPubkey,
      repo
    );

    if (!canTransfer) {
      return error(403, 'Only the current repository owner can transfer ownership');
    }

    // Verify the transfer event is from the current owner
    if (transferEvent.pubkey !== userPubkey) {
      return error(403, 'Transfer event must be signed by the current owner');
    }

    // Verify it's an ownership transfer event
    if (transferEvent.kind !== KIND.OWNERSHIP_TRANSFER) {
      return error(400, `Event must be kind ${KIND.OWNERSHIP_TRANSFER} (ownership transfer)`);
    }

    // Verify the 'a' tag references this repo
    const aTag = transferEvent.tags.find(t => t[0] === 'a');
    const expectedRepoTag = `30617:${originalOwnerPubkey}:${repo}`;
    if (!aTag || aTag[1] !== expectedRepoTag) {
      return error(400, "Transfer event 'a' tag does not match this repository");
    }

    // Get user's relays and publish
    const { outbox } = await getUserRelays(userPubkey, nostrClient);
    const combinedRelays = combineRelays(outbox);

    const result = await nostrClient.publishEvent(transferEvent as NostrEvent, combinedRelays);

    if (result.success.length === 0) {
      return error(500, 'Failed to publish transfer event to any relays');
    }

    // Clear cache so new owner is recognized immediately
    ownershipTransferService.clearCache(originalOwnerPubkey, repo);

    return json({
      success: true,
      event: transferEvent,
      published: result,
      message: 'Ownership transfer initiated successfully'
    });
  } catch (err) {
    console.error('Error transferring ownership:', err);
    return error(500, err instanceof Error ? err.message : 'Failed to transfer ownership');
  }
};
