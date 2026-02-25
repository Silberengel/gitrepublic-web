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
import { forwardEventIfEnabled } from '$lib/services/messaging/event-forwarder.js';
import logger from '$lib/services/logger.js';
import { getRelaysForEventPublishing } from '$lib/utils/repo-visibility.js';
import { fetchRepoAnnouncementsWithCache, findRepoAnnouncement } from '$lib/utils/nostr-utils.js';
import { eventCache } from '$lib/services/nostr/event-cache.js';

export const GET: RequestHandler = createRepoGetHandler(
  async (context: RepoRequestContext) => {
    const prs = await prsService.getPullRequests(context.repoOwnerPubkey, context.repo);
    return json(prs);
  },
  { operation: 'getPRs', requireRepoExists: false, requireRepoAccess: false } // PRs are stored in Nostr, don't require local repo
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

    // Get repository announcement to determine visibility and relay publishing
    const allEvents = await fetchRepoAnnouncementsWithCache(nostrClient, repoContext.repoOwnerPubkey, eventCache);
    const announcement = findRepoAnnouncement(allEvents, repoContext.repo);
    
    // Determine which relays to publish to based on visibility
    const relaysToPublish = announcement ? getRelaysForEventPublishing(announcement) : DEFAULT_NOSTR_RELAYS;
    
    // Publish the event to relays (empty array means no relay publishing, but event is still saved to repo)
    const result = relaysToPublish.length > 0 
      ? await nostrClient.publishEvent(prEvent, relaysToPublish)
      : { success: [], failed: [] };
    
    if (result.failed.length > 0 && result.success.length === 0) {
      throw handleApiError(new Error('Failed to publish pull request to all relays'), { operation: 'createPR', npub: repoContext.npub, repo: repoContext.repo }, 'Failed to publish pull request to all relays');
    }

    // Forward to messaging platforms if user has unlimited access and preferences configured
    if (requestContext.userPubkeyHex && result.success.length > 0) {
      forwardEventIfEnabled(prEvent, requestContext.userPubkeyHex)
        .catch(err => {
          // Log but don't fail the request - forwarding is optional
          logger.warn({ error: err, npub: repoContext.npub, repo: repoContext.repo }, 'Failed to forward event to messaging platforms');
        });
    }

    return json({ success: true, event: prEvent, published: result });
  },
  { operation: 'createPR', requireRepoAccess: false } // PRs can be created by anyone with access
);

export const PATCH: RequestHandler = withRepoValidation(
  async ({ repoContext, requestContext, event }) => {
    const body = await event.request.json();
    const { prId, prAuthor, status, mergeCommitId } = body;

    if (!prId || !prAuthor || !status) {
      throw handleValidationError('Missing required fields: prId, prAuthor, status', { operation: 'updatePRStatus', npub: repoContext.npub, repo: repoContext.repo });
    }

    // Check if user is maintainer
    const { MaintainerService } = await import('$lib/services/nostr/maintainer-service.js');
    const maintainerService = new MaintainerService(DEFAULT_NOSTR_RELAYS);
    const isMaintainer = await maintainerService.isMaintainer(requestContext.userPubkeyHex || '', repoContext.repoOwnerPubkey, repoContext.repo);
    
    if (!isMaintainer && requestContext.userPubkeyHex !== repoContext.repoOwnerPubkey) {
      throw handleApiError(new Error('Only repository owners and maintainers can update PR status'), { operation: 'updatePRStatus', npub: repoContext.npub, repo: repoContext.repo }, 'Unauthorized');
    }

    // Get repository announcement to determine visibility and relay publishing
    const allEvents = await fetchRepoAnnouncementsWithCache(nostrClient, repoContext.repoOwnerPubkey, eventCache);
    const announcement = findRepoAnnouncement(allEvents, repoContext.repo);
    
    // Determine which relays to publish to based on visibility
    const relaysToPublish = announcement ? getRelaysForEventPublishing(announcement) : DEFAULT_NOSTR_RELAYS;
    
    // Update PR status with visibility-based relays
    const statusEvent = await prsService.updatePRStatus(
      prId,
      prAuthor,
      repoContext.repoOwnerPubkey,
      repoContext.repo,
      status,
      mergeCommitId,
      relaysToPublish
    );

    return json({ success: true, event: statusEvent });
  },
  { operation: 'updatePRStatus', requireRepoAccess: false }
);
