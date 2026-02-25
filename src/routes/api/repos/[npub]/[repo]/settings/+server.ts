/**
 * API endpoint for repository settings
 * GET: Retrieve repository settings
 * POST: Update repository settings (requires maintainer access)
 */

import { json, error } from '@sveltejs/kit';
// @ts-ignore - SvelteKit generates this type
import type { RequestHandler } from './$types';
import { createRepoGetHandler, createRepoPostHandler } from '$lib/utils/api-handlers.js';
import type { RepoRequestContext, RequestEvent } from '$lib/utils/api-context.js';
import { handleValidationError } from '$lib/utils/error-handler.js';
import { eventCache } from '$lib/services/nostr/event-cache.js';
import { fetchRepoAnnouncementsWithCache, findRepoAnnouncement } from '$lib/utils/nostr-utils.js';
import { nostrClient } from '$lib/services/service-registry.js';
import { getVisibility, getProjectRelays } from '$lib/utils/repo-visibility.js';
import { KIND } from '$lib/types/nostr.js';
import { nip19 } from 'nostr-tools';
import { getPublicKeyWithNIP07, signEventWithNIP07 } from '$lib/services/nostr/nip07-signer.js';
import { DEFAULT_NOSTR_RELAYS, combineRelays } from '$lib/config.js';
import { getUserRelays } from '$lib/services/nostr/user-relays.js';
import { NostrClient } from '$lib/services/nostr/nostr-client.js';
import { DEFAULT_NOSTR_SEARCH_RELAYS } from '$lib/config.js';
import logger from '$lib/services/logger.js';

/**
 * GET: Retrieve repository settings
 */
export const GET: RequestHandler = createRepoGetHandler(
  async (context: RepoRequestContext) => {
    // Fetch repository announcement
    const allEvents = await fetchRepoAnnouncementsWithCache(nostrClient, context.repoOwnerPubkey, eventCache);
    const announcement = findRepoAnnouncement(allEvents, context.repo);

    if (!announcement) {
      return json({
        owner: context.npub,
        description: '',
        visibility: 'public',
        projectRelays: [],
        private: false // Backward compatibility
      });
    }

    // Extract settings from announcement
    const description = announcement.tags.find(t => t[0] === 'description')?.[1] || '';
    const visibility = getVisibility(announcement);
    const projectRelays = getProjectRelays(announcement);
    const ownerNpub = nip19.npubEncode(announcement.pubkey);

    return json({
      owner: ownerNpub,
      description,
      visibility,
      projectRelays,
      // Backward compatibility: map visibility to private boolean
      private: visibility === 'restricted' || visibility === 'private'
    });
  },
  { operation: 'getSettings', requireRepoExists: false, requireRepoAccess: false }
);

/**
 * POST: Update repository settings
 * Requires maintainer access
 */
export const POST: RequestHandler = createRepoPostHandler(
  async (context: RepoRequestContext, event: RequestEvent) => {
    // Parse request body
    let body: { description?: string; visibility?: string; projectRelays?: string[]; private?: boolean };
    try {
      body = await event.request.json();
    } catch {
      throw handleValidationError('Invalid JSON in request body', { operation: 'updateSettings', npub: context.npub, repo: context.repo });
    }

    // Fetch current announcement
    const allEvents = await fetchRepoAnnouncementsWithCache(nostrClient, context.repoOwnerPubkey, eventCache);
    const announcement = findRepoAnnouncement(allEvents, context.repo);

    if (!announcement) {
      throw handleValidationError('Repository announcement not found', { operation: 'updateSettings', npub: context.npub, repo: context.repo });
    }

    // Get user's pubkey (required for signing)
    const userPubkey = await getPublicKeyWithNIP07();
    const userPubkeyHex = typeof userPubkey === 'string' && userPubkey.length === 64
      ? userPubkey
      : nip19.decode(userPubkey).data as string;

    // Verify user is maintainer
    const { maintainerService } = await import('$lib/services/service-registry.js');
    const isMaintainer = await maintainerService.isMaintainer(userPubkeyHex, context.repoOwnerPubkey, context.repo);
    if (!isMaintainer) {
      return error(403, 'Only maintainers can update repository settings');
    }

    // Build updated tags
    const tags: string[][] = [...announcement.tags];

    // Update description
    if (body.description !== undefined) {
      const descIndex = tags.findIndex(t => t[0] === 'description');
      if (descIndex >= 0) {
        tags[descIndex] = ['description', body.description];
      } else {
        tags.push(['description', body.description]);
      }
    }

    // Update visibility
    let newVisibility: 'public' | 'unlisted' | 'restricted' | 'private' = getVisibility(announcement);
    if (body.visibility !== undefined) {
      const vis = body.visibility.toLowerCase();
      if (['public', 'unlisted', 'restricted', 'private'].includes(vis)) {
        newVisibility = vis as typeof newVisibility;
      } else {
        throw handleValidationError(`Invalid visibility: ${body.visibility}. Must be one of: public, unlisted, restricted, private`, 
          { operation: 'updateSettings', npub: context.npub, repo: context.repo });
      }
    } else if (body.private !== undefined) {
      // Backward compatibility: map private boolean to visibility
      newVisibility = body.private ? 'restricted' : 'public';
    }

    // Update visibility tag
    const visIndex = tags.findIndex(t => t[0] === 'visibility');
    if (newVisibility === 'public') {
      // Remove visibility tag if public (default)
      if (visIndex >= 0) {
        tags.splice(visIndex, 1);
      }
    } else {
      if (visIndex >= 0) {
        tags[visIndex] = ['visibility', newVisibility];
      } else {
        tags.push(['visibility', newVisibility]);
      }
    }

    // Update project-relay tags
    if (body.projectRelays !== undefined) {
      // Remove existing project-relay tags
      const projectRelayIndices: number[] = [];
      tags.forEach((tag, index) => {
        if (tag[0] === 'project-relay') {
          projectRelayIndices.push(index);
        }
      });
      // Remove in reverse order to maintain indices
      for (let i = projectRelayIndices.length - 1; i >= 0; i--) {
        tags.splice(projectRelayIndices[i], 1);
      }
      // Add new project-relay tags
      for (const relay of body.projectRelays) {
        if (relay && (relay.startsWith('ws://') || relay.startsWith('wss://'))) {
          tags.push(['project-relay', relay]);
        }
      }
    }

    // Validate: unlisted/restricted require project-relay
    if ((newVisibility === 'unlisted' || newVisibility === 'restricted')) {
      const hasProjectRelay = tags.some(t => t[0] === 'project-relay');
      if (!hasProjectRelay) {
        throw handleValidationError(
          `Visibility '${newVisibility}' requires at least one project-relay. Please provide project-relays in the request.`,
          { operation: 'updateSettings', npub: context.npub, repo: context.repo }
        );
      }
    }

    // Remove old private tag if present (migration)
    const privateIndex = tags.findIndex(t => (t[0] === 'private' && t[1] === 'true') || (t[0] === 't' && t[1] === 'private'));
    if (privateIndex >= 0) {
      tags.splice(privateIndex, 1);
    }

    // Create updated event
    const updatedEvent = {
      kind: KIND.REPO_ANNOUNCEMENT,
      pubkey: userPubkeyHex,
      created_at: Math.floor(Date.now() / 1000),
      content: announcement.content || '',
      tags
    };

    // Sign with NIP-07
    const signedEvent = await signEventWithNIP07(updatedEvent);

    // Get user's relays for publishing
    const allSearchRelays = [...new Set([...DEFAULT_NOSTR_SEARCH_RELAYS, ...DEFAULT_NOSTR_RELAYS])];
    const fullRelayClient = new NostrClient(allSearchRelays);
    
    let userRelays: string[] = [];
    try {
      const { inbox, outbox } = await getUserRelays(userPubkeyHex, fullRelayClient);
      if (outbox.length > 0) {
        userRelays = combineRelays(outbox, DEFAULT_NOSTR_RELAYS);
      } else if (inbox.length > 0) {
        userRelays = combineRelays(inbox, DEFAULT_NOSTR_RELAYS);
      } else {
        userRelays = DEFAULT_NOSTR_RELAYS;
      }
    } catch (err) {
      logger.warn({ error: err }, 'Failed to fetch user relays, using defaults');
      userRelays = DEFAULT_NOSTR_RELAYS;
    }

    // Determine which relays to publish to based on visibility
    const { getRelaysForEventPublishing } = await import('$lib/utils/repo-visibility.js');
    const relaysToPublish = getRelaysForEventPublishing(signedEvent, userRelays);

    // Publish to relays (if not private)
    if (relaysToPublish.length > 0) {
      const publishResult = await nostrClient.publishEvent(signedEvent, relaysToPublish);
      if (publishResult.failed.length > 0 && publishResult.success.length === 0) {
        logger.warn({ npub: context.npub, repo: context.repo }, 'Failed to publish settings update to all relays');
        // Don't fail the request - event is still valid
      }
    }

    // Save to repository (via announcement manager)
    const { announcementManager } = await import('$lib/services/git/announcement-manager.js');
    const repoPath = `${process.env.GIT_REPO_ROOT || '/repos'}/${context.npub}/${context.repo}.git`;
    try {
      await announcementManager.saveEvent(signedEvent, repoPath);
    } catch (err) {
      logger.error({ error: err, npub: context.npub, repo: context.repo }, 'Failed to save settings update to repository');
      // Don't fail the request - event was published to relays
    }

    // Return updated settings
    return json({
      owner: context.npub,
      description: body.description !== undefined ? body.description : (announcement.tags.find(t => t[0] === 'description')?.[1] || ''),
      visibility: newVisibility,
      projectRelays: body.projectRelays !== undefined ? body.projectRelays : getProjectRelays(announcement),
      private: newVisibility === 'restricted' || newVisibility === 'private' // Backward compatibility
    });
  },
  { operation: 'updateSettings', requireRepoExists: false }
);
