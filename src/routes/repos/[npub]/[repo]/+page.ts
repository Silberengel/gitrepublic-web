/**
 * Page metadata and OpenGraph tags for repository pages
 */

import type { PageLoad } from './$types';
import { NostrClient } from '$lib/services/nostr/nostr-client.js';
import { MaintainerService } from '$lib/services/nostr/maintainer-service.js';
import { DEFAULT_NOSTR_RELAYS } from '$lib/config.js';
import { KIND } from '$lib/types/nostr.js';
import { nip19 } from 'nostr-tools';
import { extractRequestContext } from '$lib/utils/api-context.js';

export const load: PageLoad = async ({ params, url, parent }) => {
  const { npub, repo } = params;

  if (!npub || !repo) {
    return {
      title: 'Repository Not Found',
      description: 'Repository not found'
    };
  }

  try {
    // Decode npub to get pubkey
    const decoded = nip19.decode(npub);
    if (decoded.type !== 'npub') {
      return {
        title: 'Invalid Repository',
        description: 'Invalid repository identifier'
      };
    }

    const repoOwnerPubkey = decoded.data as string;

    // Fetch repository announcement
    const nostrClient = new NostrClient(DEFAULT_NOSTR_RELAYS);
    const events = await nostrClient.fetchEvents([
      {
        kinds: [KIND.REPO_ANNOUNCEMENT],
        authors: [repoOwnerPubkey],
        '#d': [repo],
        limit: 1
      }
    ]);

    if (events.length === 0) {
      return {
        title: `${repo} - Repository Not Found`,
        description: 'Repository announcement not found'
      };
    }

    const announcement = events[0];
    
    // Check privacy - for private repos, we'll let the API endpoints handle access control
    // The page load function runs server-side but doesn't have access to client auth headers
    // So we'll mark it as private and let the frontend handle access denial
    const maintainerService = new MaintainerService(DEFAULT_NOSTR_RELAYS);
    const isPrivate = announcement.tags.some(t => 
      (t[0] === 'private' && t[1] === 'true') || 
      (t[0] === 't' && t[1] === 'private')
    );
    
    // For private repos, we can't check access here (no user context in page load)
    // The frontend will need to check access via API and show appropriate error
    // We still expose basic metadata (name) but the API will enforce access
    
    const name = announcement.tags.find(t => t[0] === 'name')?.[1] || repo;
    const description = announcement.tags.find(t => t[0] === 'description')?.[1] || '';
    const image = announcement.tags.find(t => t[0] === 'image')?.[1];
    const banner = announcement.tags.find(t => t[0] === 'banner')?.[1];
    
    // Debug: log image and banner tags if found
    if (image) console.log('[Page Load] Found image tag:', image);
    if (banner) console.log('[Page Load] Found banner tag:', banner);
    if (!image && !banner) {
      console.log('[Page Load] No image or banner tags found. Available tags:', 
        announcement.tags.filter(t => t[0] === 'image' || t[0] === 'banner').map(t => t[0]));
    }
    const cloneUrls = announcement.tags
      .filter(t => t[0] === 'clone')
      .flatMap(t => t.slice(1))
      .filter(url => url && typeof url === 'string') as string[];
    const maintainers = announcement.tags
      .filter(t => t[0] === 'maintainers')
      .flatMap(t => t.slice(1))
      .filter(m => m && typeof m === 'string') as string[];
    // Owner is the author of the announcement event
    const ownerPubkey = announcement.pubkey;
    const language = announcement.tags.find(t => t[0] === 'language')?.[1];
    const topics = announcement.tags
      .filter(t => t[0] === 't' && t[1] !== 'private')
      .map(t => t[1])
      .filter(t => t && typeof t === 'string') as string[];
    const website = announcement.tags.find(t => t[0] === 'website')?.[1];

    // Get git domain for constructing URLs
    const layoutData = await parent();
    const gitDomain = (layoutData as { gitDomain?: string }).gitDomain || url.host || 'localhost:6543';
    const protocol = gitDomain.startsWith('localhost') ? 'http' : 'https';
    const repoUrl = `${protocol}://${gitDomain}/repos/${npub}/${repo}`;

    return {
      title: `${name} - ${repo}`,
      description: description || `Repository: ${name}`,
      image: image || banner || undefined,
      banner: banner || image || undefined,
      repoName: name,
      repoDescription: description,
      repoUrl,
      repoCloneUrls: cloneUrls,
      repoMaintainers: maintainers,
      repoOwnerPubkey: ownerPubkey,
      repoLanguage: language,
      repoTopics: topics,
      repoWebsite: website,
      repoIsPrivate: isPrivate,
      ogType: 'website'
    };
  } catch (error) {
    console.error('Error loading repository metadata:', error);
    return {
      title: `${repo} - Repository`,
      description: 'Repository'
    };
  }
};
