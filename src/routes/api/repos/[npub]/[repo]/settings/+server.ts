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
      const decoded = nip19.decode(npub) as { type: string; data: unknown };
      if (decoded.type === 'npub' && typeof decoded.data === 'string') {
        repoOwnerPubkey = decoded.data;
      } else {
        return error(400, 'Invalid npub format');
      }
    } catch {
      return error(400, 'Invalid npub format');
    }

    // Check if user is owner
    if (!userPubkey) {
      return error(401, 'Authentication required');
    }

    let userPubkeyHex = userPubkey;
    try {
      const userDecoded = nip19.decode(userPubkey) as { type: string; data: unknown };
      if (userDecoded.type === 'npub' && typeof userDecoded.data === 'string') {
        userPubkeyHex = userDecoded.data;
      }
    } catch {
      // Assume it's already hex
    }

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
      const decoded = nip19.decode(npub) as { type: string; data: unknown };
      if (decoded.type === 'npub' && typeof decoded.data === 'string') {
        repoOwnerPubkey = decoded.data;
      } else {
        return error(400, 'Invalid npub format');
      }
    } catch {
      return error(400, 'Invalid npub format');
    }

    let userPubkeyHex = userPubkey;
    try {
      const userDecoded = nip19.decode(userPubkey) as { type: string; data: unknown };
      if (userDecoded.type === 'npub' && typeof userDecoded.data === 'string') {
        userPubkeyHex = userDecoded.data;
      }
    } catch {
      // Assume it's already hex
    }

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
    const protocol = gitDomain.startsWith('localhost') ? 'http' : 'https';
    const gitUrl = `${protocol}://${gitDomain}/${npub}/${repo}.git`;

    // Get Tor .onion URL if available
    const { getTorGitUrl } = await import('$lib/services/tor/hidden-service.js');
    const torOnionUrl = await getTorGitUrl(npub, repo);

    // Build clone URLs - include regular domain and Tor .onion if available
    const cloneUrlList = [
      gitUrl,
      ...(torOnionUrl ? [torOnionUrl] : []),
      ...(cloneUrls || []).filter((url: string) => url && !url.includes(gitDomain) && !url.includes('.onion'))
    ];

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
