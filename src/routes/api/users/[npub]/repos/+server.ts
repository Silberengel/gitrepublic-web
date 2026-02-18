/**
 * API endpoint for listing a user's repositories with privacy checks
 * Returns only repositories the current user can view
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { NostrClient } from '$lib/services/nostr/nostr-client.js';
import { MaintainerService } from '$lib/services/nostr/maintainer-service.js';
import { DEFAULT_NOSTR_RELAYS, GIT_DOMAIN } from '$lib/config.js';
import { KIND } from '$lib/types/nostr.js';
import { nip19 } from 'nostr-tools';
import { handleApiError, handleValidationError } from '$lib/utils/error-handler.js';
import { extractRequestContext } from '$lib/utils/api-context.js';
import logger from '$lib/services/logger.js';
import type { NostrEvent } from '$lib/types/nostr.js';
import type { RequestEvent } from '@sveltejs/kit';

const nostrClient = new NostrClient(DEFAULT_NOSTR_RELAYS);
const maintainerService = new MaintainerService(DEFAULT_NOSTR_RELAYS);

export const GET: RequestHandler = async (event) => {
  try {
    const { npub } = event.params;
    if (!npub) {
      return handleValidationError('Missing npub parameter', { operation: 'getUserRepos' });
    }
    
    // Decode npub to get pubkey
    let userPubkey: string;
    try {
      const decoded = nip19.decode(npub);
      if (decoded.type !== 'npub') {
        return handleValidationError('Invalid npub format', { operation: 'getUserRepos', npub });
      }
      userPubkey = decoded.data as string;
    } catch {
      return handleValidationError('Invalid npub format', { operation: 'getUserRepos', npub });
    }
    
    const requestContext = extractRequestContext(event);
    const viewerPubkey = requestContext.userPubkeyHex || null;
    const gitDomain = event.url.searchParams.get('domain') || GIT_DOMAIN;
    
    // Fetch user's repository announcements
    const events = await nostrClient.fetchEvents([
      {
        kinds: [KIND.REPO_ANNOUNCEMENT],
        authors: [userPubkey],
        limit: 100
      }
    ]);

    const repos: NostrEvent[] = [];
    
    // Process each announcement with privacy filtering
    for (const event of events) {
      const cloneUrls = event.tags
        .filter(t => t[0] === 'clone')
        .flatMap(t => t.slice(1))
        .filter(url => url && typeof url === 'string');
      
      // Filter for repos that list our domain
      const hasDomain = cloneUrls.some(url => url.includes(gitDomain));
      if (!hasDomain) continue;
      
      // Extract repo name from d-tag
      const dTag = event.tags.find(t => t[0] === 'd')?.[1];
      if (!dTag) continue;
      
      // Check privacy
      const isPrivate = event.tags.some(t => 
        (t[0] === 'private' && t[1] === 'true') || 
        (t[0] === 't' && t[1] === 'private')
      );
      
      // Check if viewer can view this repo
      let canView = false;
      if (!isPrivate) {
        canView = true; // Public repos are viewable by anyone
      } else if (viewerPubkey) {
        // Private repos require authentication
        try {
          canView = await maintainerService.canView(viewerPubkey, userPubkey, dTag);
        } catch (err) {
          logger.warn({ error: err, pubkey: userPubkey, repo: dTag }, 'Failed to check repo access');
          canView = false;
        }
      }
      
      // Only include repos the viewer can view
      if (!canView) continue;
      
      repos.push(event);
    }
    
    // Sort by created_at descending
    repos.sort((a, b) => b.created_at - a.created_at);
    
    return json({
      repos,
      total: repos.length
    });
  } catch (err) {
    return handleApiError(err, { operation: 'getUserRepos' }, 'Failed to get user repositories');
  }
};
