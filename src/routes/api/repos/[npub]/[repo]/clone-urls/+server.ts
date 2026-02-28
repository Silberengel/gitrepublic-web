/**
 * RESTful Clone URLs Resource Endpoint
 * 
 * GET    /api/repos/{npub}/{repo}/clone-urls            # List clone URLs
 * POST   /api/repos/{npub}/{repo}/clone-urls            # Check reachability (body: {urls: [...]})
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createRepoGetHandler, createRepoPostHandler } from '$lib/utils/api-handlers.js';
import type { RepoRequestContext, RequestEvent } from '$lib/utils/api-context.js';
import { handleApiError } from '$lib/utils/error-handler.js';
import { getCloneUrlsReachability } from '$lib/services/git/clone-url-reachability.js';
import { extractCloneUrls } from '$lib/utils/nostr-utils.js';
import { NostrClient } from '$lib/services/nostr/nostr-client.js';
import { DEFAULT_NOSTR_RELAYS, DEFAULT_NOSTR_SEARCH_RELAYS } from '$lib/config.js';
import { eventCache } from '$lib/services/nostr/event-cache.js';
import { fetchRepoAnnouncementsWithCache, findRepoAnnouncement } from '$lib/utils/nostr-utils.js';
import { nostrClient } from '$lib/services/service-registry.js';
import logger from '$lib/services/logger.js';

/**
 * GET: List clone URLs
 * Query params:
 *   - includeReachability: boolean (optional) - Include reachability status
 *   - forceRefresh: boolean (optional) - Force refresh reachability cache
 */
export const GET: RequestHandler = createRepoGetHandler(
  async (context: RepoRequestContext, event: RequestEvent) => {
    try {
      const url = new URL(event.request.url);
      const includeReachability = url.searchParams.get('includeReachability') === 'true';
      const forceRefresh = url.searchParams.get('forceRefresh') === 'true';

      // Fetch repository announcement (case-insensitive) with caching
      let allEvents = await fetchRepoAnnouncementsWithCache(nostrClient, context.repoOwnerPubkey, eventCache);
      let announcement = findRepoAnnouncement(allEvents, context.repo);
      
      // If no events found in cache/default relays, try all relays
      if (!announcement) {
        const allRelays = [...new Set([...DEFAULT_NOSTR_RELAYS, ...DEFAULT_NOSTR_SEARCH_RELAYS])];
        if (allRelays.length > DEFAULT_NOSTR_RELAYS.length) {
          const allRelaysClient = new NostrClient(allRelays);
          allEvents = await fetchRepoAnnouncementsWithCache(allRelaysClient, context.repoOwnerPubkey, eventCache);
          announcement = findRepoAnnouncement(allEvents, context.repo);
        }
      }
      
      if (!announcement) {
        logger.warn({ npub: context.npub, repo: context.repo }, 'Repository announcement not found for clone URLs');
        return error(404, 'Repository announcement not found');
      }
      
      // Extract clone URLs
      const cloneUrls = extractCloneUrls(announcement, false);
      
      if (!includeReachability) {
        return json({ 
          cloneUrls,
          count: cloneUrls.length
        });
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
      
      // Get reachability for all clone URLs
      const reachabilityResults = await getCloneUrlsReachability(
        cloneUrls, 
        5000, 
        forceRefresh, 
        relayUrls.length > 0 ? relayUrls : undefined
      );
      
      return json({ 
        cloneUrls,
        count: cloneUrls.length,
        reachability: reachabilityResults
      });
    } catch (err) {
      return handleApiError(err, { operation: 'getCloneUrls', npub: context.npub, repo: context.repo }, 'Failed to get clone URLs');
    }
  },
  { operation: 'getCloneUrls', requireRepoExists: false, requireRepoAccess: false }
);

/**
 * POST: Check reachability of clone URLs
 * Body: { urls: string[], forceRefresh?: boolean }
 */
export const POST: RequestHandler = createRepoPostHandler(
  async (context: RepoRequestContext, event: RequestEvent) => {
    try {
      const body = await event.request.json();
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
      return handleApiError(err, { operation: 'checkReachability', npub: context.npub, repo: context.repo }, 'Failed to check clone URL reachability');
    }
  },
  { operation: 'checkReachability', requireRepoExists: false, requireRepoAccess: false }
);
