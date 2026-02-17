/**
 * API endpoint for Pull Requests (NIP-34 kind 1618)
 */

import { json } from '@sveltejs/kit';
// @ts-ignore - SvelteKit generates this type
import type { RequestHandler } from './$types';
import { prsService, nostrClient } from '$lib/services/service-registry.js';
import { createRepoGetHandler, withRepoValidation } from '$lib/utils/api-handlers.js';
import type { RepoRequestContext, RequestEvent } from '$lib/utils/api-context.js';
import { handleValidationError, handleApiError } from '$lib/utils/error-handler.js';
import { DEFAULT_NOSTR_RELAYS } from '$lib/config.js';

export const GET: RequestHandler = createRepoGetHandler(
  async (context: RepoRequestContext) => {
    const prs = await prsService.getPullRequests(context.repoOwnerPubkey, context.repo);
    return json(prs);
  },
  { operation: 'getPRs' }
);

export const POST: RequestHandler = withRepoValidation(
  async ({ repoContext, requestContext, event }) => {
    const body = await event.request.json();
    const { event: prEvent } = body;

    if (!prEvent) {
      throw handleValidationError('Missing event in request body', { operation: 'createPR', npub: repoContext.npub, repo: repoContext.repo });
    }

    // Verify the event is properly signed
    if (!prEvent.sig || !prEvent.id) {
      throw handleValidationError('Invalid event: missing signature or ID', { operation: 'createPR', npub: repoContext.npub, repo: repoContext.repo });
    }

    // Publish the event to relays
    const result = await nostrClient.publishEvent(prEvent, DEFAULT_NOSTR_RELAYS);
    
    if (result.failed.length > 0 && result.success.length === 0) {
      throw handleApiError(new Error('Failed to publish pull request to all relays'), { operation: 'createPR', npub: repoContext.npub, repo: repoContext.repo }, 'Failed to publish pull request to all relays');
    }

    return json({ success: true, event: prEvent, published: result });
  },
  { operation: 'createPR', requireRepoAccess: false } // PRs can be created by anyone with access
);
