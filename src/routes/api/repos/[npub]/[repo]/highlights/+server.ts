/**
 * API endpoint for Highlights (NIP-84 kind 9802) and Comments (NIP-22 kind 1111)
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { highlightsService, nostrClient } from '$lib/services/service-registry.js';
import { DEFAULT_NOSTR_RELAYS, combineRelays } from '$lib/config.js';
import { getUserRelays } from '$lib/services/nostr/user-relays.js';
import { verifyEvent } from 'nostr-tools';
import type { NostrEvent } from '$lib/types/nostr.js';
import { createRepoGetHandler, withRepoValidation } from '$lib/utils/api-handlers.js';
import type { RepoRequestContext, RequestEvent } from '$lib/utils/api-context.js';
import { handleApiError, handleValidationError } from '$lib/utils/error-handler.js';
import { decodeNpubToHex } from '$lib/utils/npub-utils.js';
import { forwardEventIfEnabled } from '$lib/services/messaging/event-forwarder.js';
import logger from '$lib/services/logger.js';

/**
 * GET - Get highlights for a pull request
 * Query params: prId, prAuthor
 */
export const GET: RequestHandler = createRepoGetHandler(
  async (context: RepoRequestContext, event: RequestEvent) => {
    const prId = event.url.searchParams.get('prId');
    const prAuthor = event.url.searchParams.get('prAuthor');

    if (!prId || !prAuthor) {
      return handleValidationError('Missing prId or prAuthor parameter', { operation: 'getHighlights', npub: context.npub, repo: context.repo });
    }

    // Decode prAuthor if it's an npub
    const prAuthorPubkey = decodeNpubToHex(prAuthor) || prAuthor;

    // Get highlights for the PR
    const highlights = await highlightsService.getHighlightsForPR(
      prId,
      prAuthorPubkey,
      context.repoOwnerPubkey,
      context.repo
    );

    // Also get top-level comments on the PR
    const prComments = await highlightsService.getCommentsForPR(prId);

    return json({
      highlights,
      comments: prComments
    });
  },
  { operation: 'getHighlights', requireRepoAccess: false } // Highlights are public
);

/**
 * POST - Create a highlight or comment
 * Body: { type: 'highlight' | 'comment', event, userPubkey }
 */
export const POST: RequestHandler = withRepoValidation(
  async ({ repoContext, requestContext, event }) => {
    const body = await event.request.json();
    const { type, event: highlightEvent, userPubkey } = body;

    if (!type || !highlightEvent || !userPubkey) {
      throw handleValidationError('Missing type, event, or userPubkey in request body', { operation: 'createHighlight', npub: repoContext.npub, repo: repoContext.repo });
    }

    if (type !== 'highlight' && type !== 'comment') {
      throw handleValidationError('Type must be "highlight" or "comment"', { operation: 'createHighlight', npub: repoContext.npub, repo: repoContext.repo });
    }

    // Verify the event is properly signed
    if (!highlightEvent.sig || !highlightEvent.id) {
      throw handleValidationError('Invalid event: missing signature or ID', { operation: 'createHighlight', npub: repoContext.npub, repo: repoContext.repo });
    }

    if (!verifyEvent(highlightEvent)) {
      throw handleValidationError('Invalid event signature', { operation: 'createHighlight', npub: repoContext.npub, repo: repoContext.repo });
    }

    // Get user's relays and publish
    const { outbox } = await getUserRelays(userPubkey, nostrClient);
    const combinedRelays = combineRelays(outbox);

    const result = await nostrClient.publishEvent(highlightEvent as NostrEvent, combinedRelays);
    
    if (result.failed.length > 0 && result.success.length === 0) {
      throw handleApiError(new Error('Failed to publish to all relays'), { operation: 'createHighlight', npub: repoContext.npub, repo: repoContext.repo }, 'Failed to publish to all relays');
    }

    // Forward to messaging platforms if user has unlimited access and preferences configured
    // Decode userPubkey if it's an npub
    const userPubkeyHex = requestContext.userPubkeyHex || (userPubkey ? decodeNpubToHex(userPubkey) : null);
    if (userPubkeyHex && result.success.length > 0) {
      forwardEventIfEnabled(highlightEvent as NostrEvent, userPubkeyHex)
        .catch(err => {
          // Log but don't fail the request - forwarding is optional
          logger.warn({ error: err, npub: repoContext.npub, repo: repoContext.repo }, 'Failed to forward event to messaging platforms');
        });
    }

    return json({ success: true, event: highlightEvent, published: result });
  },
  { operation: 'createHighlight', requireRepoAccess: false } // Highlights can be created by anyone
);
