/**
 * API endpoint for Highlights (NIP-84 kind 9802) and Comments (NIP-22 kind 1111)
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { HighlightsService } from '$lib/services/nostr/highlights-service.js';
import { DEFAULT_NOSTR_RELAYS } from '$lib/config.js';
import { nip19 } from 'nostr-tools';
import { requireNpubHex, decodeNpubToHex } from '$lib/utils/npub-utils.js';
import { verifyEvent } from 'nostr-tools';
import type { NostrEvent } from '$lib/types/nostr.js';
import { combineRelays } from '$lib/config.js';
import { getUserRelays } from '$lib/services/nostr/user-relays.js';
import { NostrClient } from '$lib/services/nostr/nostr-client.js';
import logger from '$lib/services/logger.js';

const highlightsService = new HighlightsService(DEFAULT_NOSTR_RELAYS);
const nostrClient = new NostrClient(DEFAULT_NOSTR_RELAYS);

/**
 * GET - Get highlights for a pull request
 * Query params: prId, prAuthor
 */
export const GET: RequestHandler = async ({ params, url }) => {
  const { npub, repo } = params;
  const prId = url.searchParams.get('prId');
  const prAuthor = url.searchParams.get('prAuthor');

  if (!npub || !repo) {
    return error(400, 'Missing npub or repo parameter');
  }

  if (!prId || !prAuthor) {
    return error(400, 'Missing prId or prAuthor parameter');
  }

  try {
    // Decode npub to get pubkey
    let repoOwnerPubkey: string;
    try {
      repoOwnerPubkey = requireNpubHex(npub);
    } catch {
      return error(400, 'Invalid npub format');
    }

    // Decode prAuthor if it's an npub
    const prAuthorPubkey = decodeNpubToHex(prAuthor) || prAuthor;

    // Get highlights for the PR
    const highlights = await highlightsService.getHighlightsForPR(
      prId,
      prAuthorPubkey,
      repoOwnerPubkey,
      repo
    );

    // Also get top-level comments on the PR
    const prComments = await highlightsService.getCommentsForPR(prId);

    return json({
      highlights,
      comments: prComments
    });
  } catch (err) {
    logger.error({ error: err, npub, repo }, 'Error fetching highlights');
    return error(500, err instanceof Error ? err.message : 'Failed to fetch highlights');
  }
};

/**
 * POST - Create a highlight or comment
 * Body: { type: 'highlight' | 'comment', event, userPubkey }
 */
export const POST: RequestHandler = async ({ params, request }) => {
  const { npub, repo } = params;

  if (!npub || !repo) {
    return error(400, 'Missing npub or repo parameter');
  }

  try {
    const body = await request.json();
    const { type, event, userPubkey } = body;

    if (!type || !event || !userPubkey) {
      return error(400, 'Missing type, event, or userPubkey in request body');
    }

    if (type !== 'highlight' && type !== 'comment') {
      return error(400, 'Type must be "highlight" or "comment"');
    }

    // Verify the event is properly signed
    if (!event.sig || !event.id) {
      return error(400, 'Invalid event: missing signature or ID');
    }

    if (!verifyEvent(event)) {
      return error(400, 'Invalid event signature');
    }

    // Get user's relays and publish
    const { outbox } = await getUserRelays(userPubkey, nostrClient);
    const combinedRelays = combineRelays(outbox);

    const result = await highlightsService['nostrClient'].publishEvent(event as NostrEvent, combinedRelays);
    
    if (result.failed.length > 0 && result.success.length === 0) {
      return error(500, 'Failed to publish to all relays');
    }

    return json({ success: true, event, published: result });
  } catch (err) {
    logger.error({ error: err, npub, repo }, 'Error creating highlight/comment');
    return error(500, err instanceof Error ? err.message : 'Failed to create highlight/comment');
  }
};
