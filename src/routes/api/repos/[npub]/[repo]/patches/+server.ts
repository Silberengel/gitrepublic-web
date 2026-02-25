/**
 * API endpoint for Patches (NIP-34 kind 1617)
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { nostrClient, maintainerService } from '$lib/services/service-registry.js';
import { createRepoGetHandler, withRepoValidation } from '$lib/utils/api-handlers.js';
import type { RepoRequestContext, RequestEvent } from '$lib/utils/api-context.js';
import { handleValidationError, handleApiError } from '$lib/utils/error-handler.js';
import { DEFAULT_NOSTR_RELAYS } from '$lib/config.js';
import { forwardEventIfEnabled } from '$lib/services/messaging/event-forwarder.js';
import logger from '$lib/services/logger.js';
import { KIND, type NostrEvent } from '$lib/types/nostr.js';
import { signEventWithNIP07 } from '$lib/services/nostr/nip07-signer.js';
import { getRelaysForEventPublishing } from '$lib/utils/repo-visibility.js';
import { fetchRepoAnnouncementsWithCache, findRepoAnnouncement } from '$lib/utils/nostr-utils.js';
import { eventCache } from '$lib/services/nostr/event-cache.js';

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
    ]) as NostrEvent[];

    // Fetch status events for each patch
    const patchIds = patches.map(p => p.id);
    const statusEvents = await nostrClient.fetchEvents([
      {
        kinds: [KIND.STATUS_OPEN, KIND.STATUS_APPLIED, KIND.STATUS_CLOSED, KIND.STATUS_DRAFT],
        '#e': patchIds,
        limit: 1000
      }
    ]) as NostrEvent[];

    // Group status events by patch ID and get the most recent one
    const statusMap = new Map<string, NostrEvent>();
    for (const status of statusEvents) {
      const rootTag = status.tags.find(t => t[0] === 'e' && t[3] === 'root');
      if (rootTag && rootTag[1]) {
        const patchId = rootTag[1];
        const existing = statusMap.get(patchId);
        if (!existing || status.created_at > existing.created_at) {
          statusMap.set(patchId, status);
        }
      }
    }

    // Combine patches with their status
    const patchesWithStatus = patches.map(patch => {
      const statusEvent = statusMap.get(patch.id);
      let status: 'open' | 'applied' | 'closed' | 'draft' = 'open';
      
      if (statusEvent) {
        if (statusEvent.kind === KIND.STATUS_OPEN) status = 'open';
        else if (statusEvent.kind === KIND.STATUS_APPLIED) status = 'applied';
        else if (statusEvent.kind === KIND.STATUS_CLOSED) status = 'closed';
        else if (statusEvent.kind === KIND.STATUS_DRAFT) status = 'draft';
      }

      return {
        ...patch,
        status,
        statusEvent
      };
    });

    return json(patchesWithStatus);
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

    // Get repository announcement to determine visibility and relay publishing
    const allEvents = await fetchRepoAnnouncementsWithCache(nostrClient, repoContext.repoOwnerPubkey, eventCache);
    const announcement = findRepoAnnouncement(allEvents, repoContext.repo);
    
    // Determine which relays to publish to based on visibility
    const relaysToPublish = announcement ? getRelaysForEventPublishing(announcement) : DEFAULT_NOSTR_RELAYS;
    
    // Publish the event to relays (empty array means no relay publishing, but event is still saved to repo)
    const result = relaysToPublish.length > 0 
      ? await nostrClient.publishEvent(patchEvent, relaysToPublish)
      : { success: [], failed: [] };
    
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

export const PATCH: RequestHandler = withRepoValidation(
  async ({ repoContext, requestContext, event }) => {
    const body = await event.request.json();
    const { patchId, patchAuthor, status } = body;

    if (!patchId || !patchAuthor || !status) {
      throw handleValidationError('Missing required fields: patchId, patchAuthor, status', { operation: 'updatePatchStatus', npub: repoContext.npub, repo: repoContext.repo });
    }

    // Check if user is maintainer or patch author
    const isMaintainer = await maintainerService.isMaintainer(requestContext.userPubkeyHex || '', repoContext.repoOwnerPubkey, repoContext.repo);
    const isAuthor = requestContext.userPubkeyHex === patchAuthor;
    
    if (!isMaintainer && !isAuthor && requestContext.userPubkeyHex !== repoContext.repoOwnerPubkey) {
      throw handleApiError(new Error('Only repository owners, maintainers, or patch authors can update patch status'), { operation: 'updatePatchStatus', npub: repoContext.npub, repo: repoContext.repo }, 'Unauthorized');
    }

    // Validate status
    const validStatuses: ('open' | 'applied' | 'closed' | 'draft')[] = ['open', 'applied', 'closed', 'draft'];
    const normalizedStatus = status.toLowerCase() as 'open' | 'applied' | 'closed' | 'draft';
    if (!validStatuses.includes(normalizedStatus)) {
      throw handleValidationError(`Invalid status: must be one of ${validStatuses.join(', ')}`, { operation: 'updatePatchStatus', npub: repoContext.npub, repo: repoContext.repo });
    }

    // Determine status kind
    let statusKind: number;
    switch (normalizedStatus) {
      case 'open':
        statusKind = KIND.STATUS_OPEN;
        break;
      case 'applied':
        statusKind = KIND.STATUS_APPLIED;
        break;
      case 'closed':
        statusKind = KIND.STATUS_CLOSED;
        break;
      case 'draft':
        statusKind = KIND.STATUS_DRAFT;
        break;
    }

    const repoAddress = getRepoAddress(repoContext.repoOwnerPubkey, repoContext.repo);
    const tags: string[][] = [
      ['e', patchId, '', 'root'],
      ['p', repoContext.repoOwnerPubkey],
      ['p', patchAuthor],
      ['a', repoAddress]
    ];

    const statusEvent = await signEventWithNIP07({
      kind: statusKind,
      content: `Patch ${normalizedStatus}`,
      tags,
      created_at: Math.floor(Date.now() / 1000),
      pubkey: ''
    });

    // Get repository announcement to determine visibility and relay publishing
    const allEvents = await fetchRepoAnnouncementsWithCache(nostrClient, repoContext.repoOwnerPubkey, eventCache);
    const announcement = findRepoAnnouncement(allEvents, repoContext.repo);
    
    // Determine which relays to publish to based on visibility
    const relaysToPublish = announcement ? getRelaysForEventPublishing(announcement) : DEFAULT_NOSTR_RELAYS;
    
    // Publish status event (empty array means no relay publishing, but event is still saved to repo)
    const result = relaysToPublish.length > 0 
      ? await nostrClient.publishEvent(statusEvent, relaysToPublish)
      : { success: [], failed: [] };
    
    if (result.failed.length > 0 && result.success.length === 0) {
      throw handleApiError(new Error('Failed to publish status event to all relays'), { operation: 'updatePatchStatus', npub: repoContext.npub, repo: repoContext.repo }, 'Failed to publish status event');
    }

    return json({ success: true, event: statusEvent });
  },
  { operation: 'updatePatchStatus', requireRepoAccess: false }
);
