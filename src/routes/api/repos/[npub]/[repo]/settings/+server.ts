/**
 * API endpoint for repository settings
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { nostrClient, maintainerService, ownershipTransferService, fileManager } from '$lib/services/service-registry.js';
import { DEFAULT_NOSTR_RELAYS, combineRelays } from '$lib/config.js';
import { getUserRelays } from '$lib/services/nostr/user-relays.js';
import { KIND } from '$lib/types/nostr.js';
import { signEventWithNIP07 } from '$lib/services/nostr/nip07-signer.js';
import { createRepoGetHandler, withRepoValidation } from '$lib/utils/api-handlers.js';
import type { RepoRequestContext, RequestEvent } from '$lib/utils/api-context.js';
import { handleApiError, handleValidationError, handleNotFoundError, handleAuthorizationError } from '$lib/utils/error-handler.js';
import { generateVerificationFile, VERIFICATION_FILE_PATH } from '$lib/services/nostr/repo-verification.js';
import { nip19 } from 'nostr-tools';
import logger from '$lib/services/logger.js';

/**
 * GET - Get repository settings
 */
export const GET: RequestHandler = createRepoGetHandler(
  async (context: RepoRequestContext) => {
    // Check if user is owner
    if (!context.userPubkeyHex) {
      throw handleApiError(new Error('Authentication required'), { operation: 'getSettings', npub: context.npub, repo: context.repo }, 'Authentication required');
    }

    const currentOwner = await ownershipTransferService.getCurrentOwner(context.repoOwnerPubkey, context.repo);
    if (context.userPubkeyHex !== currentOwner) {
      throw handleAuthorizationError('Only the repository owner can access settings', { operation: 'getSettings', npub: context.npub, repo: context.repo });
    }

    // Get repository announcement
    const events = await nostrClient.fetchEvents([
      {
        kinds: [KIND.REPO_ANNOUNCEMENT],
        authors: [currentOwner],
        '#d': [context.repo],
        limit: 1
      }
    ]);

    if (events.length === 0) {
      throw handleNotFoundError('Repository announcement not found', { operation: 'getSettings', npub: context.npub, repo: context.repo });
    }

    const announcement = events[0];
    const name = announcement.tags.find(t => t[0] === 'name')?.[1] || context.repo;
    const description = announcement.tags.find(t => t[0] === 'description')?.[1] || '';
    const cloneUrls = announcement.tags
      .filter(t => t[0] === 'clone')
      .flatMap(t => t.slice(1))
      .filter(url => url && typeof url === 'string') as string[];
    const maintainers = announcement.tags
      .filter(t => t[0] === 'maintainers')
      .flatMap(t => t.slice(1))
      .filter(m => m && typeof m === 'string') as string[];
    const chatRelays = announcement.tags
      .filter(t => t[0] === 'chat-relay')
      .flatMap(t => t.slice(1))
      .filter(url => url && typeof url === 'string') as string[];
    const privacyInfo = await maintainerService.getPrivacyInfo(currentOwner, context.repo);
    const isPrivate = privacyInfo.isPrivate;

    return json({
      name,
      description,
      cloneUrls,
      maintainers,
      chatRelays,
      isPrivate,
      owner: currentOwner,
      npub: context.npub
    });
  },
  { operation: 'getSettings', requireRepoAccess: false } // Override to check owner instead
);

/**
 * POST - Update repository settings
 */
export const POST: RequestHandler = withRepoValidation(
  async ({ repoContext, requestContext, event }) => {
    if (!requestContext.userPubkeyHex) {
      throw handleApiError(new Error('Authentication required'), { operation: 'updateSettings', npub: repoContext.npub, repo: repoContext.repo }, 'Authentication required');
    }

    const body = await event.request.json();
    const { name, description, cloneUrls, maintainers, chatRelays, isPrivate } = body;

    // Check if user is owner
    const currentOwner = await ownershipTransferService.getCurrentOwner(repoContext.repoOwnerPubkey, repoContext.repo);
    if (requestContext.userPubkeyHex !== currentOwner) {
      throw handleAuthorizationError('Only the repository owner can update settings', { operation: 'updateSettings', npub: repoContext.npub, repo: repoContext.repo });
    }

    // Get existing announcement
    const events = await nostrClient.fetchEvents([
      {
        kinds: [KIND.REPO_ANNOUNCEMENT],
        authors: [currentOwner],
        '#d': [repoContext.repo],
        limit: 1
      }
    ]);

    if (events.length === 0) {
      throw handleNotFoundError('Repository announcement not found', { operation: 'updateSettings', npub: repoContext.npub, repo: repoContext.repo });
    }

    const existingAnnouncement = events[0];

    // Build updated tags
    const gitDomain = process.env.GIT_DOMAIN || 'localhost:6543';
    const isLocalhost = gitDomain.startsWith('localhost') || gitDomain.startsWith('127.0.0.1');
    const protocol = isLocalhost ? 'http' : 'https';
    const gitUrl = `${protocol}://${gitDomain}/${repoContext.npub}/${repoContext.repo}.git`;

    // Get Tor .onion URL if available
    const { getTorGitUrl } = await import('$lib/services/tor/hidden-service.js');
    const torOnionUrl = await getTorGitUrl(repoContext.npub, repoContext.repo);

    // Filter user-provided clone URLs (exclude localhost and .onion duplicates)
    const userCloneUrls = (cloneUrls || []).filter((url: string) => {
      if (!url || !url.trim()) return false;
      // Exclude if it's our domain or already a .onion
      if (url.includes(gitDomain)) return false;
      if (url.includes('.onion')) return false;
      return true;
    });

    // Build clone URLs - NEVER include localhost, only include public domain or Tor .onion
    const cloneUrlList: string[] = [];
    
    // Add our domain URL only if it's NOT localhost (explicitly check the URL)
    if (!isLocalhost && !gitUrl.includes('localhost') && !gitUrl.includes('127.0.0.1')) {
      cloneUrlList.push(gitUrl);
    }
    
    // Add Tor .onion URL if available (always useful, even with localhost)
    if (torOnionUrl) {
      cloneUrlList.push(torOnionUrl);
    }
    
    // Add user-provided clone URLs
    cloneUrlList.push(...userCloneUrls);

    // Validate: If using localhost, require either Tor .onion URL or at least one other clone URL
    if (isLocalhost && !torOnionUrl && userCloneUrls.length === 0) {
      throw error(400, 'Cannot update with only localhost. You need either a Tor .onion address or at least one other clone URL.');
    }

    const tags: string[][] = [
      ['d', repoContext.repo],
      ['name', name || repoContext.repo],
      ...(description ? [['description', description]] : []),
      ['clone', ...cloneUrlList],
      ['relays', ...DEFAULT_NOSTR_RELAYS],
      ...(isPrivate ? [['private', 'true']] : []),
      ...(maintainers || []).map((m: string) => ['maintainers', m]),
      ...(chatRelays && chatRelays.length > 0 ? [['chat-relay', ...chatRelays]] : [])
    ];

    // Preserve other tags from original announcement
    const preserveTags = ['r', 'web', 't'];
    for (const tag of existingAnnouncement.tags) {
      if (preserveTags.includes(tag[0]) && !tags.some(t => t[0] === tag[0])) {
        tags.push(tag);
      }
    }

    // Create updated announcement
    const updatedAnnouncement = {
      kind: KIND.REPO_ANNOUNCEMENT,
      pubkey: currentOwner,
      created_at: Math.floor(Date.now() / 1000),
      content: '',
      tags
    };

    // Sign and publish
    const signedEvent = await signEventWithNIP07(updatedAnnouncement);
    
    const { outbox } = await getUserRelays(currentOwner, nostrClient);
    const combinedRelays = combineRelays(outbox);

    const result = await nostrClient.publishEvent(signedEvent, combinedRelays);

    if (result.success.length === 0) {
      throw error(500, 'Failed to publish updated announcement to relays');
    }

    // Save updated announcement to repo (offline papertrail)
    try {
      const announcementFileContent = generateVerificationFile(signedEvent, currentOwner);
      
      // Save to repo if it exists locally
      if (fileManager.repoExists(repoContext.npub, repoContext.repo)) {
        await fileManager.writeFile(
          repoContext.npub,
          repoContext.repo,
          VERIFICATION_FILE_PATH,
          announcementFileContent,
          `Update repository announcement: ${signedEvent.id.slice(0, 16)}...`,
          'Nostr',
          `${currentOwner}@nostr`,
          'main'
        ).catch(err => {
          // Log but don't fail - publishing to relays is more important
          logger.warn({ error: err, npub: repoContext.npub, repo: repoContext.repo }, 'Failed to save updated announcement to repo');
        });
      }
    } catch (err) {
      // Log but don't fail - publishing to relays is more important
      logger.warn({ error: err, npub: repoContext.npub, repo: repoContext.repo }, 'Failed to save updated announcement to repo');
    }

    return json({ success: true, event: signedEvent });
  },
  { operation: 'updateSettings', requireRepoAccess: false } // Override to check owner instead
);
