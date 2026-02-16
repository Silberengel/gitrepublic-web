/**
 * Page metadata and OpenGraph tags for repository pages
 */

import type { PageLoad } from './$types';
import { NostrClient } from '$lib/services/nostr/nostr-client.js';
import { DEFAULT_NOSTR_RELAYS } from '$lib/config.js';
import { KIND } from '$lib/types/nostr.js';
import { nip19 } from 'nostr-tools';

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
    const name = announcement.tags.find(t => t[0] === 'name')?.[1] || repo;
    const description = announcement.tags.find(t => t[0] === 'description')?.[1] || '';
    const image = announcement.tags.find(t => t[0] === 'image')?.[1];
    const banner = announcement.tags.find(t => t[0] === 'banner')?.[1];

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
