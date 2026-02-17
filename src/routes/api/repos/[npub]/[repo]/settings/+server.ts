/**
 * API endpoint for repository settings
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { NostrClient } from '$lib/services/nostr/nostr-client.js';
import { DEFAULT_NOSTR_RELAYS, combineRelays, getGitUrl } from '$lib/config.js';
import { getUserRelays } from '$lib/services/nostr/user-relays.js';
import { KIND } from '$lib/types/nostr.js';
import { nip19 } from 'nostr-tools';
import { requireNpubHex, decodeNpubToHex } from '$lib/utils/npub-utils.js';
import { signEventWithNIP07 } from '$lib/services/nostr/nip07-signer.js';
import { MaintainerService } from '$lib/services/nostr/maintainer-service.js';
import logger from '$lib/services/logger.js';
import { OwnershipTransferService } from '$lib/services/nostr/ownership-transfer-service.js';

const nostrClient = new NostrClient(DEFAULT_NOSTR_RELAYS);
const maintainerService = new MaintainerService(DEFAULT_NOSTR_RELAYS);
const ownershipTransferService = new OwnershipTransferService(DEFAULT_NOSTR_RELAYS);

/**
 * GET - Get repository settings
 */
export const GET: RequestHandler = async ({ params, url, request }) => {
  const { npub, repo } = params;
  const userPubkey = url.searchParams.get('userPubkey') || request.headers.get('x-user-pubkey');

  if (!npub || !repo) {
    return error(400, 'Missing npub or repo parameter');
  }

  try {
    // Decode npub to get pubkey
    let repoOwnerPubkey: string;
    try {
      repoOwnerPubkey = requireNpubHex(npub);
    } catch {
      return error(400, 'Invalid npub format');
    }

    // Check if user is owner
    if (!userPubkey) {
      return error(401, 'Authentication required');
    }

    const userPubkeyHex = decodeNpubToHex(userPubkey) || userPubkey;

    const currentOwner = await ownershipTransferService.getCurrentOwner(repoOwnerPubkey, repo);
    if (userPubkeyHex !== currentOwner) {
      return error(403, 'Only the repository owner can access settings');
    }

    // Get repository announcement
    const events = await nostrClient.fetchEvents([
      {
        kinds: [KIND.REPO_ANNOUNCEMENT],
        authors: [currentOwner],
        '#d': [repo],
        limit: 1
      }
    ]);

    if (events.length === 0) {
      return error(404, 'Repository announcement not found');
    }

    const announcement = events[0];
    const name = announcement.tags.find(t => t[0] === 'name')?.[1] || repo;
    const description = announcement.tags.find(t => t[0] === 'description')?.[1] || '';
    const cloneUrls = announcement.tags
      .filter(t => t[0] === 'clone')
      .flatMap(t => t.slice(1))
      .filter(url => url && typeof url === 'string') as string[];
    const maintainers = announcement.tags
      .filter(t => t[0] === 'maintainers')
      .flatMap(t => t.slice(1))
      .filter(m => m && typeof m === 'string') as string[];
    const privacyInfo = await maintainerService.getPrivacyInfo(currentOwner, repo);
    const isPrivate = privacyInfo.isPrivate;

    return json({
      name,
      description,
      cloneUrls,
      maintainers,
      isPrivate,
      owner: currentOwner,
      npub
    });
  } catch (err) {
    logger.error({ error: err, npub, repo }, 'Error getting repository settings');
    return error(500, err instanceof Error ? err.message : 'Failed to get repository settings');
  }
};

/**
 * POST - Update repository settings
 */
export const POST: RequestHandler = async ({ params, request }) => {
  const { npub, repo } = params;

  if (!npub || !repo) {
    return error(400, 'Missing npub or repo parameter');
  }

  try {
    const body = await request.json();
    const { userPubkey, name, description, cloneUrls, maintainers, isPrivate } = body;

    if (!userPubkey) {
      return error(401, 'Authentication required');
    }

    // Decode npub to get pubkey
    let repoOwnerPubkey: string;
    try {
      repoOwnerPubkey = requireNpubHex(npub);
    } catch {
      return error(400, 'Invalid npub format');
    }

    const userPubkeyHex = decodeNpubToHex(userPubkey) || userPubkey;

    // Check if user is owner
    const currentOwner = await ownershipTransferService.getCurrentOwner(repoOwnerPubkey, repo);
    if (userPubkeyHex !== currentOwner) {
      return error(403, 'Only the repository owner can update settings');
    }

    // Get existing announcement
    const events = await nostrClient.fetchEvents([
      {
        kinds: [KIND.REPO_ANNOUNCEMENT],
        authors: [currentOwner],
        '#d': [repo],
        limit: 1
      }
    ]);

    if (events.length === 0) {
      return error(404, 'Repository announcement not found');
    }

    const existingAnnouncement = events[0];

    // Build updated tags
    const gitDomain = process.env.GIT_DOMAIN || 'localhost:6543';
    const isLocalhost = gitDomain.startsWith('localhost') || gitDomain.startsWith('127.0.0.1');
    const protocol = isLocalhost ? 'http' : 'https';
    const gitUrl = `${protocol}://${gitDomain}/${npub}/${repo}.git`;

    // Get Tor .onion URL if available
    const { getTorGitUrl } = await import('$lib/services/tor/hidden-service.js');
    const torOnionUrl = await getTorGitUrl(npub, repo);

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
      return error(400, 'Cannot update with only localhost. You need either a Tor .onion address or at least one other clone URL.');
    }

    const tags: string[][] = [
      ['d', repo],
      ['name', name || repo],
      ...(description ? [['description', description]] : []),
      ['clone', ...cloneUrlList],
      ['relays', ...DEFAULT_NOSTR_RELAYS],
      ...(isPrivate ? [['private', 'true']] : []),
      ...(maintainers || []).map((m: string) => ['maintainers', m])
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
      return error(500, 'Failed to publish updated announcement to relays');
    }

    return json({ success: true, event: signedEvent });
  } catch (err) {
    logger.error({ error: err, npub, repo }, 'Error updating repository settings');
    return error(500, err instanceof Error ? err.message : 'Failed to update repository settings');
  }
};
