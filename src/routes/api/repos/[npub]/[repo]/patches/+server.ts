/**
 * API endpoint for Patches (NIP-34 kind 1617)
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { nostrClient } from '$lib/services/service-registry.js';
import { createRepoGetHandler, withRepoValidation } from '$lib/utils/api-handlers.js';
import type { RepoRequestContext, RequestEvent } from '$lib/utils/api-context.js';
import { handleValidationError, handleApiError } from '$lib/utils/error-handler.js';
import { DEFAULT_NOSTR_RELAYS } from '$lib/config.js';
import { forwardEventIfEnabled } from '$lib/services/messaging/event-forwarder.js';
import logger from '$lib/services/logger.js';
import { KIND } from '$lib/types/nostr.js';

function getRepoAddress(repoOwnerPubkey: string, repoId: string): string {
  return `${KIND.REPO_ANNOUNCEMENT}:${repoOwnerPubkey}:${repoId}`;
}

export const GET: RequestHandler = createRepoGetHandler(
  async (context: RepoRequestContext) => {
    const repoAddress = getRepoAddress(context.repoOwnerPubkey, context.repo);
    
    const patches = await nostrClient.fetchEvents([
      {
        kinds: [KIND.PATCH],
        '#a': [repoAddress],
        limit: 100
      }
    ]);

    return json(patches);
  },
  { operation: 'getPatches', requireRepoExists: false, requireRepoAccess: false } // Patches are stored in Nostr, don't require local repo
);

export const POST: RequestHandler = withRepoValidation(
  async ({ repoContext, requestContext, event }) => {
    const body = await event.request.json();
    const { event: patchEvent } = body;

    if (!patchEvent) {
      throw handleValidationError('Missing event in request body', { operation: 'createPatch', npub: repoContext.npub, repo: repoContext.repo });
    }

    // Verify the event is properly signed
    if (!patchEvent.sig || !patchEvent.id) {
      throw handleValidationError('Invalid event: missing signature or ID', { operation: 'createPatch', npub: repoContext.npub, repo: repoContext.repo });
    }

    // Publish the event to relays
    const result = await nostrClient.publishEvent(patchEvent, DEFAULT_NOSTR_RELAYS);
    
    if (result.failed.length > 0 && result.success.length === 0) {
      throw handleApiError(new Error('Failed to publish patch to all relays'), { operation: 'createPatch', npub: repoContext.npub, repo: repoContext.repo }, 'Failed to publish patch to all relays');
    }

    // Forward to messaging platforms if user has unlimited access and preferences configured
    if (requestContext.userPubkeyHex && result.success.length > 0) {
      forwardEventIfEnabled(patchEvent, requestContext.userPubkeyHex)
        .catch(err => {
          // Log but don't fail the request - forwarding is optional
          logger.warn({ error: err, npub: repoContext.npub, repo: repoContext.repo }, 'Failed to forward event to messaging platforms');
        });
    }

    return json({ success: true, event: patchEvent, published: result });
  },
  { operation: 'createPatch', requireRepoAccess: false } // Patches can be created by anyone with access
);
