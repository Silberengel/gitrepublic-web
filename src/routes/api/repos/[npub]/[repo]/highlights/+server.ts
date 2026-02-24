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
import { KIND } from '$lib/types/nostr.js';
import { createRepoGetHandler, withRepoValidation } from '$lib/utils/api-handlers.js';
import type { RepoRequestContext, RequestEvent } from '$lib/utils/api-context.js';
import { handleApiError, handleValidationError } from '$lib/utils/error-handler.js';
import { decodeNpubToHex } from '$lib/utils/npub-utils.js';
import { forwardEventIfEnabled } from '$lib/services/messaging/event-forwarder.js';
import logger from '$lib/services/logger.js';

/**
 * GET - Get highlights for a pull request or patch
 * Query params: prId, prAuthor (for PRs) OR patchId, patchAuthor (for patches)
 */
export const GET: RequestHandler = createRepoGetHandler(
  async (context: RepoRequestContext, event: RequestEvent) => {
    const prId = event.url.searchParams.get('prId');
    const prAuthor = event.url.searchParams.get('prAuthor');
    const patchId = event.url.searchParams.get('patchId');
    const patchAuthor = event.url.searchParams.get('patchAuthor');

    // Support both PR and patch highlights
    try {
      if (prId && prAuthor) {
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
        const prComments = await highlightsService.getCommentsForTarget(prId, KIND.PULL_REQUEST);

        return json({
          highlights,
          comments: prComments
        });
      } else if (patchId && patchAuthor) {
        // Decode patchAuthor if it's an npub
        const patchAuthorPubkey = decodeNpubToHex(patchAuthor) || patchAuthor;

        // Get highlights for the patch
        const highlights = await highlightsService.getHighlightsForPatch(
          patchId,
          patchAuthorPubkey,
          context.repoOwnerPubkey,
          context.repo
        );

        // Also get top-level comments on the patch
        const patchComments = await highlightsService.getCommentsForTarget(patchId, KIND.PATCH);

        return json({
          highlights,
          comments: patchComments
        });
      } else {
        return handleValidationError('Missing prId/prAuthor or patchId/patchAuthor parameters', { operation: 'getHighlights', npub: context.npub, repo: context.repo });
      }
    } catch (err) {
      // Log error but return empty arrays instead of crashing
      // Some relays may fail (e.g., require payment), but we should still return successfully
      logger.warn({ error: err, npub: context.npub, repo: context.repo, prId, patchId }, 'Error fetching highlights, returning empty arrays');
      return json({
        highlights: [],
        comments: []
      });
    }
  },
  { operation: 'getHighlights', requireRepoAccess: false, requireRepoExists: false } // Highlights are public and don't require repo to be cloned
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
    let result;
    try {
      const { outbox } = await getUserRelays(userPubkey, nostrClient);
      const combinedRelays = combineRelays(outbox);

      result = await nostrClient.publishEvent(highlightEvent as NostrEvent, combinedRelays);
    } catch (err) {
      // Log error but don't fail - some relays may have succeeded
      logger.warn({ error: err, npub: repoContext.npub, repo: repoContext.repo, eventId: highlightEvent.id }, 'Error publishing highlight event, some relays may have succeeded');
      // Return a result indicating failure, but don't throw
      result = { success: [], failed: [{ relay: 'unknown', error: String(err) }] };
    }
    
    // Only throw if ALL relays failed - partial success is acceptable
    if (result.failed.length > 0 && result.success.length === 0) {
      logger.warn({ npub: repoContext.npub, repo: repoContext.repo, eventId: highlightEvent.id, failed: result.failed }, 'Failed to publish to all relays, but continuing anyway');
      // Don't throw - return success anyway since the event was created
      // The user can retry if needed
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
  { operation: 'createHighlight', requireRepoAccess: false, requireRepoExists: false } // Highlights can be created by anyone and don't require repo to be cloned
);
