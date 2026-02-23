/**
 * API endpoint for testing clone URL reachability
 * POST: Test reachability of clone URLs
 * GET: Get cached reachability status
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getCloneUrlsReachability, type ReachabilityResult } from '$lib/services/git/clone-url-reachability.js';
import { extractCloneUrls } from '$lib/utils/nostr-utils.js';
import { NostrClient } from '$lib/services/nostr/nostr-client.js';
import { DEFAULT_NOSTR_RELAYS } from '$lib/config.js';
import { KIND } from '$lib/types/nostr.js';
import { nip19 } from 'nostr-tools';
import { requireNpubHex } from '$lib/utils/npub-utils.js';
import { fetchRepoAnnouncementsWithCache, findRepoAnnouncement } from '$lib/utils/nostr-utils.js';
import { eventCache } from '$lib/services/nostr/event-cache.js';
import logger from '$lib/services/logger.js';

/**
 * GET: Get reachability status for clone URLs
 * Query params:
 *   - forceRefresh: boolean (optional) - Force refresh even if cached
 */
export const GET: RequestHandler = async ({ params, url }) => {
  const { npub, repo } = params;
  
  if (!npub || !repo) {
    return error(400, 'Missing npub or repo parameter');
  }
  
  try {
    // Decode npub to get pubkey
    const decoded = nip19.decode(npub);
    if (decoded.type !== 'npub') {
      return error(400, 'Invalid npub format');
    }
    
    const repoOwnerPubkey = decoded.data as string;
    
    // Fetch repository announcement
    const nostrClient = new NostrClient(DEFAULT_NOSTR_RELAYS);
    const allEvents = await fetchRepoAnnouncementsWithCache(nostrClient, repoOwnerPubkey, eventCache);
    const announcement = findRepoAnnouncement(allEvents, repo);
    
    if (!announcement) {
      return error(404, 'Repository announcement not found');
    }
    
    // Extract clone URLs
    const cloneUrls = extractCloneUrls(announcement, false);
    
    if (cloneUrls.length === 0) {
      return json({ results: [] });
    }
    
    // Extract relay URLs from relays tag (for proper GRASP server detection)
    const relayUrls: string[] = [];
    for (const tag of announcement.tags) {
      if (tag[0] === 'relays') {
        for (let i = 1; i < tag.length; i++) {
          const relayUrl = tag[i];
          if (relayUrl && typeof relayUrl === 'string' && (relayUrl.startsWith('ws://') || relayUrl.startsWith('wss://'))) {
            relayUrls.push(relayUrl);
          }
        }
      }
    }
    
    // Check if force refresh is requested
    const forceRefresh = url.searchParams.get('forceRefresh') === 'true';
    
    // Get reachability for all clone URLs (with relay URLs for GRASP detection)
    const results = await getCloneUrlsReachability(cloneUrls, 5000, forceRefresh, relayUrls.length > 0 ? relayUrls : undefined);
    
    return json({ results });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error({ error: errorMessage, npub, repo }, 'Failed to check clone URL reachability');
    return error(500, `Failed to check clone URL reachability: ${errorMessage}`);
  }
};

/**
 * POST: Test reachability of specific clone URLs
 * Body: { urls: string[], forceRefresh?: boolean }
 */
export const POST: RequestHandler = async ({ request, params }) => {
  const { npub, repo } = params;
  
  if (!npub || !repo) {
    return error(400, 'Missing npub or repo parameter');
  }
  
  try {
    const body = await request.json();
    const { urls, forceRefresh = false } = body;
    
    if (!Array.isArray(urls) || urls.length === 0) {
      return error(400, 'urls must be a non-empty array');
    }
    
    // Validate URLs are strings
    if (!urls.every(url => typeof url === 'string')) {
      return error(400, 'All URLs must be strings');
    }
    
    // Get reachability for specified URLs
    const results = await getCloneUrlsReachability(urls, 5000, forceRefresh);
    
    return json({ results });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error({ error: errorMessage, npub, repo }, 'Failed to test clone URL reachability');
    return error(500, `Failed to test clone URL reachability: ${errorMessage}`);
  }
};
