/**
 * RESTful Maintainers Resource Endpoint
 * 
 * GET    /api/repos/{npub}/{repo}/maintainers           # List maintainers
 * POST   /api/repos/{npub}/{repo}/maintainers           # Add maintainer
 * DELETE /api/repos/{npub}/{repo}/maintainers/{npub}    # Remove maintainer
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { maintainerService } from '$lib/services/service-registry.js';
import { createRepoGetHandler, createRepoPostHandler } from '$lib/utils/api-handlers.js';
import type { RepoRequestContext, RequestEvent } from '$lib/utils/api-context.js';
import { handleValidationError, handleAuthorizationError } from '$lib/utils/error-handler.js';
import { nip19 } from 'nostr-tools';
import { getPublicKeyWithNIP07, signEventWithNIP07 } from '$lib/services/nostr/nip07-signer.js';
import { eventCache } from '$lib/services/nostr/event-cache.js';
import { fetchRepoAnnouncementsWithCache, findRepoAnnouncement } from '$lib/utils/nostr-utils.js';
import { nostrClient } from '$lib/services/service-registry.js';
import { KIND } from '$lib/types/nostr.js';
import { DEFAULT_NOSTR_RELAYS, combineRelays } from '$lib/config.js';
import { getUserRelays } from '$lib/services/nostr/user-relays.js';
import { NostrClient } from '$lib/services/nostr/nostr-client.js';
import { DEFAULT_NOSTR_SEARCH_RELAYS } from '$lib/config.js';
import logger from '$lib/services/logger.js';
import { getRelaysForEventPublishing } from '$lib/utils/repo-visibility.js';
import { AnnouncementManager } from '$lib/services/git/announcement-manager.js';

const repoRoot = typeof process !== 'undefined' && process.env?.GIT_REPO_ROOT
  ? process.env.GIT_REPO_ROOT
  : '/repos';

/**
 * GET: List maintainers
 */
export const GET: RequestHandler = createRepoGetHandler(
  async (context: RepoRequestContext) => {
    const { maintainers, owner } = await maintainerService.getMaintainers(context.repoOwnerPubkey, context.repo);

    // Convert hex pubkeys to npubs for response
    const maintainerNpubs = maintainers.map(p => nip19.npubEncode(p));
    const ownerNpub = nip19.npubEncode(owner);

    // If userPubkey provided, check if they're a maintainer
    if (context.userPubkeyHex) {
      const isMaintainer = maintainers.includes(context.userPubkeyHex);
      return json({ 
        maintainers: maintainerNpubs,
        owner: ownerNpub,
        isMaintainer
      });
    }

    return json({ 
      maintainers: maintainerNpubs, 
      owner: ownerNpub 
    });
  },
  { operation: 'getMaintainers', requireRepoExists: false, requireRepoAccess: false }
);

/**
 * POST: Add maintainer
 * Body: { maintainer: "npub..." }
 */
export const POST: RequestHandler = createRepoPostHandler(
  async (context: RepoRequestContext, event: RequestEvent) => {
    if (!context.userPubkeyHex) {
      return error(401, 'Authentication required');
    }

    // Verify user is owner or maintainer
    const isMaintainer = await maintainerService.isMaintainer(context.userPubkeyHex, context.repoOwnerPubkey, context.repo);
    if (!isMaintainer) {
      return error(403, 'Only maintainers can add maintainers');
    }

    const body = await event.request.json();
    const { maintainer } = body;

    if (!maintainer) {
      throw handleValidationError('Missing maintainer in request body', { 
        operation: 'addMaintainer', 
        npub: context.npub, 
        repo: context.repo 
      });
    }

    // Decode maintainer npub to hex
    let maintainerHex: string;
    
    // Try as hex first (most common case)
    if (/^[0-9a-f]{64}$/i.test(maintainer)) {
      maintainerHex = maintainer.toLowerCase();
    } else {
      // Try decoding as npub
      try {
        const decoded = nip19.decode(maintainer) as { type: string; data: unknown };
        if (decoded.type !== 'npub' || typeof decoded.data !== 'string') {
          throw handleValidationError('Invalid maintainer format. Must be npub or hex pubkey', { 
            operation: 'addMaintainer', 
            npub: context.npub, 
            repo: context.repo 
          });
        }
        maintainerHex = decoded.data;
      } catch (err) {
        if (err instanceof Error && err.message.includes('Invalid maintainer format')) {
          throw err;
        }
        throw handleValidationError('Invalid maintainer format. Must be npub or hex pubkey', { 
          operation: 'addMaintainer', 
          npub: context.npub, 
          repo: context.repo 
        });
      }
    }

    // Get current announcement
    const allEvents = await fetchRepoAnnouncementsWithCache(nostrClient, context.repoOwnerPubkey, eventCache);
    const announcement = findRepoAnnouncement(allEvents, context.repo);

    if (!announcement) {
      throw handleValidationError('Repository announcement not found', { 
        operation: 'addMaintainer', 
        npub: context.npub, 
        repo: context.repo 
      });
    }

    // Get current maintainers
    const { maintainers: currentMaintainers } = await maintainerService.getMaintainers(
      context.repoOwnerPubkey,
      context.repo
    );

    // Check if already a maintainer
    if (currentMaintainers.includes(maintainerHex)) {
      return json({ 
        success: true, 
        message: 'Maintainer already exists',
        maintainer: maintainer
      });
    }

    // Build updated tags
    const tags: string[][] = [...announcement.tags];

    // Remove existing maintainers tags
    const maintainerTagIndices: number[] = [];
    tags.forEach((tag, index) => {
      if (tag[0] === 'maintainers') {
        maintainerTagIndices.push(index);
      }
    });
    for (let i = maintainerTagIndices.length - 1; i >= 0; i--) {
      tags.splice(maintainerTagIndices[i], 1);
    }

    // Add all maintainers (including new one)
    const allMaintainers = [...currentMaintainers, maintainerHex];
    if (allMaintainers.length > 0) {
      tags.push(['maintainers', ...allMaintainers]);
    }

    // Create updated event
    const updatedEvent = {
      kind: KIND.REPO_ANNOUNCEMENT,
      pubkey: context.userPubkeyHex,
      created_at: Math.floor(Date.now() / 1000),
      content: announcement.content || '',
      tags
    };

    // Sign and publish
    const signedEvent = await signEventWithNIP07(updatedEvent);
    
    // Get user's relays
    const allSearchRelays = [...new Set([...DEFAULT_NOSTR_SEARCH_RELAYS, ...DEFAULT_NOSTR_RELAYS])];
    const fullRelayClient = new NostrClient(allSearchRelays);
    
    let userRelays: string[] = [];
    try {
      const { inbox, outbox } = await getUserRelays(context.userPubkeyHex, fullRelayClient);
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

    const visibilityRelays = getRelaysForEventPublishing(signedEvent);
    const relaysToPublish = visibilityRelays.length > 0 ? combineRelays([...visibilityRelays, ...userRelays]) : [];

    if (relaysToPublish.length > 0) {
      await nostrClient.publishEvent(signedEvent, relaysToPublish);
    }

    // Save to repository
    const repoPath = `${repoRoot}/${context.npub}/${context.repo}.git`;
    const announcementManager = new AnnouncementManager(repoRoot);
    try {
      await announcementManager.ensureAnnouncementInRepo(repoPath, signedEvent);
    } catch (err) {
      logger.error({ error: err }, 'Failed to save maintainer update to repository');
    }

    return json({ 
      success: true, 
      maintainer: maintainer,
      message: 'Maintainer added successfully'
    });
  },
  { operation: 'addMaintainer', requireRepoExists: false }
);

/**
 * DELETE: Remove maintainer
 * Path: /api/repos/{npub}/{repo}/maintainers/{maintainerNpub}
 */
export const DELETE: RequestHandler = createRepoGetHandler(
  async (context: RepoRequestContext, event: RequestEvent) => {
    if (!context.userPubkeyHex) {
      return error(401, 'Authentication required');
    }

    // Get maintainer npub from path
    const url = new URL(event.request.url);
    const pathParts = url.pathname.split('/');
    const maintainerNpub = pathParts[pathParts.length - 1]; // Last part of path

    if (!maintainerNpub || maintainerNpub === 'maintainers') {
      throw handleValidationError('Missing maintainer npub in path', { 
        operation: 'removeMaintainer', 
        npub: context.npub, 
        repo: context.repo 
      });
    }

    // Verify user is owner or maintainer
    const isMaintainer = await maintainerService.isMaintainer(context.userPubkeyHex, context.repoOwnerPubkey, context.repo);
    if (!isMaintainer) {
      return error(403, 'Only maintainers can remove maintainers');
    }

    // Decode maintainer npub to hex
    let maintainerHex: string;
    try {
      const decoded = nip19.decode(maintainerNpub) as { type: string; data: unknown };
      if (decoded.type !== 'npub' || typeof decoded.data !== 'string') {
        throw handleValidationError('Invalid maintainer npub format', { 
          operation: 'removeMaintainer', 
          npub: context.npub, 
          repo: context.repo 
        });
      }
      maintainerHex = decoded.data;
    } catch (err) {
      if (err instanceof Error && err.message.includes('Invalid maintainer')) {
        throw err;
      }
      throw handleValidationError('Invalid maintainer npub format', { 
        operation: 'removeMaintainer', 
        npub: context.npub, 
        repo: context.repo 
      });
    }

    // Get current maintainers
    const { maintainers: currentMaintainers, owner } = await maintainerService.getMaintainers(
      context.repoOwnerPubkey,
      context.repo
    );

    // Cannot remove owner
    if (maintainerHex === owner) {
      return error(403, 'Cannot remove repository owner from maintainers');
    }

    // Check if maintainer exists
    if (!currentMaintainers.includes(maintainerHex)) {
      return json({ 
        success: true, 
        message: 'Maintainer not found (may have already been removed)',
        maintainer: maintainerNpub
      });
    }

    // Get current announcement
    const allEvents = await fetchRepoAnnouncementsWithCache(nostrClient, context.repoOwnerPubkey, eventCache);
    const announcement = findRepoAnnouncement(allEvents, context.repo);

    if (!announcement) {
      throw handleValidationError('Repository announcement not found', { 
        operation: 'removeMaintainer', 
        npub: context.npub, 
        repo: context.repo 
      });
    }

    // Build updated tags
    const tags: string[][] = [...announcement.tags];

    // Remove existing maintainers tags
    const maintainerTagIndices: number[] = [];
    tags.forEach((tag, index) => {
      if (tag[0] === 'maintainers') {
        maintainerTagIndices.push(index);
      }
    });
    for (let i = maintainerTagIndices.length - 1; i >= 0; i--) {
      tags.splice(maintainerTagIndices[i], 1);
    }

    // Add all maintainers except the one being removed
    const remainingMaintainers = currentMaintainers.filter(m => m !== maintainerHex);
    if (remainingMaintainers.length > 0) {
      tags.push(['maintainers', ...remainingMaintainers]);
    }

    // Create updated event
    const updatedEvent = {
      kind: KIND.REPO_ANNOUNCEMENT,
      pubkey: context.userPubkeyHex,
      created_at: Math.floor(Date.now() / 1000),
      content: announcement.content || '',
      tags
    };

    // Sign and publish
    const signedEvent = await signEventWithNIP07(updatedEvent);
    
    // Get user's relays
    const allSearchRelays = [...new Set([...DEFAULT_NOSTR_SEARCH_RELAYS, ...DEFAULT_NOSTR_RELAYS])];
    const fullRelayClient = new NostrClient(allSearchRelays);
    
    let userRelays: string[] = [];
    try {
      const { inbox, outbox } = await getUserRelays(context.userPubkeyHex, fullRelayClient);
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

    const visibilityRelays = getRelaysForEventPublishing(signedEvent);
    const relaysToPublish = visibilityRelays.length > 0 ? combineRelays([...visibilityRelays, ...userRelays]) : [];

    if (relaysToPublish.length > 0) {
      await nostrClient.publishEvent(signedEvent, relaysToPublish);
    }

    // Save to repository
    const repoPath = `${repoRoot}/${context.npub}/${context.repo}.git`;
    const announcementManager = new AnnouncementManager(repoRoot);
    try {
      await announcementManager.ensureAnnouncementInRepo(repoPath, signedEvent);
    } catch (err) {
      logger.error({ error: err }, 'Failed to save maintainer update to repository');
    }

    return json({ 
      success: true, 
      maintainer: maintainerNpub,
      message: 'Maintainer removed successfully'
    });
  },
  { operation: 'removeMaintainer', requireRepoExists: false }
);
