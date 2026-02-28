/**
 * RESTful Pull Request Individual Resource Endpoint
 * 
 * GET    /api/repos/{npub}/{repo}/pull-requests/{id}    # Get pull request
 * PATCH  /api/repos/{npub}/{repo}/pull-requests/{id}   # Update pull request status
 */

import { json } from '@sveltejs/kit';
// @ts-ignore - SvelteKit generates this type
import type { RequestHandler } from './$types';
import { prsService, nostrClient } from '$lib/services/service-registry.js';
import { createRepoGetHandler, withRepoValidation } from '$lib/utils/api-handlers.js';
import type { RepoRequestContext, RequestEvent } from '$lib/utils/api-context.js';
import { handleValidationError, handleApiError } from '$lib/utils/error-handler.js';
import { DEFAULT_NOSTR_RELAYS } from '$lib/config.js';
import { getRelaysForEventPublishing } from '$lib/utils/repo-visibility.js';
import { fetchRepoAnnouncementsWithCache, findRepoAnnouncement } from '$lib/utils/nostr-utils.js';
import { eventCache } from '$lib/services/nostr/event-cache.js';
import { KIND } from '$lib/types/nostr.js';

export const GET: RequestHandler = createRepoGetHandler(
  async (context: RepoRequestContext, event: RequestEvent) => {
    const id = (event.params as any).id;
    
    if (!id) {
      throw handleValidationError('Missing pull request ID', { operation: 'getPullRequest', npub: context.npub, repo: context.repo });
    }

    try {
      // Fetch the PR event
      const prEvents = await nostrClient.fetchEvents([
        {
          kinds: [KIND.PULL_REQUEST],
          ids: [id],
          limit: 1
        }
      ]);

      if (prEvents.length === 0) {
        throw handleApiError(new Error('Pull request not found'), { operation: 'getPullRequest', npub: context.npub, repo: context.repo }, 'Pull request not found');
      }

      return json(prEvents[0]);
    } catch (err) {
      throw handleApiError(err, { operation: 'getPullRequest', npub: context.npub, repo: context.repo }, 'Failed to get pull request');
    }
  },
  { operation: 'getPullRequest', requireRepoExists: false, requireRepoAccess: false }
);

export const PATCH: RequestHandler = withRepoValidation(
  async ({ repoContext, requestContext, event }) => {
    const id = (event.params as any).id;
    const body = await event.request.json();
    const { status, mergeCommitId, newCommitId, mergeBase } = body;

    if (!id) {
      throw handleValidationError('Missing pull request ID', { operation: 'updatePullRequest', npub: repoContext.npub, repo: repoContext.repo });
    }

    // Fetch the PR to get the author
    const prEvents = await nostrClient.fetchEvents([
      {
        kinds: [KIND.PULL_REQUEST],
        ids: [id],
        limit: 1
      }
    ]);

    if (prEvents.length === 0) {
      throw handleApiError(new Error('Pull request not found'), { operation: 'updatePullRequest', npub: repoContext.npub, repo: repoContext.repo }, 'Pull request not found');
    }

    const prEvent = prEvents[0];
    const prAuthor = prEvent.pubkey;

    // If updating status, check if user is maintainer
    if (status !== undefined) {
      const { MaintainerService } = await import('$lib/services/nostr/maintainer-service.js');
      const maintainerService = new MaintainerService(DEFAULT_NOSTR_RELAYS);
      const isMaintainer = await maintainerService.isMaintainer(requestContext.userPubkeyHex || '', repoContext.repoOwnerPubkey, repoContext.repo);
      
      if (!isMaintainer && requestContext.userPubkeyHex !== repoContext.repoOwnerPubkey) {
        throw handleApiError(new Error('Only repository owners and maintainers can update PR status'), { operation: 'updatePullRequestStatus', npub: repoContext.npub, repo: repoContext.repo }, 'Unauthorized');
      }

      if (!status) {
        throw handleValidationError('Missing required field: status', { operation: 'updatePullRequestStatus', npub: repoContext.npub, repo: repoContext.repo });
      }

      // Get repository announcement to determine visibility and relay publishing
      const allEvents = await fetchRepoAnnouncementsWithCache(nostrClient, repoContext.repoOwnerPubkey, eventCache);
      const announcement = findRepoAnnouncement(allEvents, repoContext.repo);
      
      // Determine which relays to publish to based on visibility
      const relaysToPublish = announcement ? getRelaysForEventPublishing(announcement) : DEFAULT_NOSTR_RELAYS;
      
      // Update PR status with visibility-based relays
      const statusEvent = await prsService.updatePRStatus(
        id,
        prAuthor,
        repoContext.repoOwnerPubkey,
        repoContext.repo,
        status,
        mergeCommitId,
        relaysToPublish
      );

      return json({ success: true, event: statusEvent });
    }

    // If updating commit, only PR author can update
    if (newCommitId !== undefined) {
      if (requestContext.userPubkeyHex !== prAuthor) {
        throw handleApiError(new Error('Only the PR author can update the PR commit'), { operation: 'updatePullRequest', npub: repoContext.npub, repo: repoContext.repo }, 'Unauthorized');
      }

      const { getGitUrl } = await import('$lib/config.js');
      const cloneUrl = getGitUrl(repoContext.npub, repoContext.repo);
      const updateEvent = await prsService.updatePullRequest(
        id,
        prAuthor,
        repoContext.repoOwnerPubkey,
        repoContext.repo,
        newCommitId,
        cloneUrl,
        mergeBase
      );

      return json({ success: true, event: updateEvent });
    }

    throw handleValidationError('Missing required field: status or newCommitId', { operation: 'updatePullRequest', npub: repoContext.npub, repo: repoContext.repo });
  },
  { operation: 'updatePullRequest', requireRepoAccess: false }
);
