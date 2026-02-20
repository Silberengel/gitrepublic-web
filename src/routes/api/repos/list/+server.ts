/**
 * API endpoint for listing repositories with privacy checks
 * Returns only repositories the current user can view
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { NostrClient } from '$lib/services/nostr/nostr-client.js';
import { MaintainerService } from '$lib/services/nostr/maintainer-service.js';
import { DEFAULT_NOSTR_RELAYS, GIT_DOMAIN } from '$lib/config.js';
import { KIND } from '$lib/types/nostr.js';
import { nip19 } from 'nostr-tools';
import { handleApiError } from '$lib/utils/error-handler.js';
import { extractRequestContext } from '$lib/utils/api-context.js';
import logger from '$lib/services/logger.js';
import type { NostrEvent } from '$lib/types/nostr.js';
import type { RequestEvent } from '@sveltejs/kit';

const nostrClient = new NostrClient(DEFAULT_NOSTR_RELAYS);
const maintainerService = new MaintainerService(DEFAULT_NOSTR_RELAYS);

interface RepoListItem {
  event: NostrEvent;
  npub: string;
  repoName: string;
  isRegistered: boolean; // Has this domain in clone URLs
}

export const GET: RequestHandler = async (event) => {
  try {
    const requestContext = extractRequestContext(event);
    const userPubkey = requestContext.userPubkeyHex || null;
    const gitDomain = event.url.searchParams.get('domain') || GIT_DOMAIN;
    
    // Fetch all repository announcements
    const events = await nostrClient.fetchEvents([
      { kinds: [KIND.REPO_ANNOUNCEMENT], limit: 100 }
    ]);

    const repos: RepoListItem[] = [];
    
    // Process each announcement
    for (const event of events) {
      const cloneUrls = event.tags
        .filter(t => t[0] === 'clone')
        .flatMap(t => t.slice(1))
        .filter(url => url && typeof url === 'string');
      
      // Check if repo has this domain in clone URLs
      const hasDomain = cloneUrls.some(url => url.includes(gitDomain));
      
      // Extract repo name from d-tag
      const dTag = event.tags.find(t => t[0] === 'd')?.[1];
      if (!dTag) continue;
      
      // Check privacy
      const isPrivate = event.tags.some(t => 
        (t[0] === 'private' && t[1] === 'true') || 
        (t[0] === 't' && t[1] === 'private')
      );
      
      // Check if user can view this repo
      let canView = false;
      if (!isPrivate) {
        canView = true; // Public repos are viewable by anyone
      } else if (userPubkey) {
        // Private repos require authentication
        try {
          canView = await maintainerService.canView(userPubkey, event.pubkey, dTag);
        } catch (err) {
          logger.warn({ error: err, pubkey: event.pubkey, repo: dTag }, 'Failed to check repo access');
          canView = false;
        }
      }
      
      // Only include repos the user can view
      if (!canView) continue;
      
      // Extract npub from clone URLs or convert pubkey
      let npub: string;
      const domainUrl = cloneUrls.find(url => url.includes(gitDomain));
      if (domainUrl) {
        const match = domainUrl.match(/\/(npub[a-z0-9]+)\//);
        if (match) {
          npub = match[1];
        } else {
          npub = nip19.npubEncode(event.pubkey);
        }
      } else {
        npub = nip19.npubEncode(event.pubkey);
      }
      
      repos.push({
        event,
        npub,
        repoName: dTag,
        isRegistered: hasDomain
      });
    }
    
    // Only return registered repos (repos with this domain in clone URLs)
    const registered = repos.filter(r => r.isRegistered);
    
    // Sort by created_at descending
    registered.sort((a, b) => b.event.created_at - a.event.created_at);
    
    return json({
      registered,
      total: registered.length
    });
  } catch (err) {
    return handleApiError(err, { operation: 'listRepos' }, 'Failed to list repositories');
  }
};
