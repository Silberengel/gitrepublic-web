/**
 * Page metadata and OpenGraph tags for repository pages
 */

import type { PageLoad } from './$types';
import { NostrClient } from '$lib/services/nostr/nostr-client.js';
import { MaintainerService } from '$lib/services/nostr/maintainer-service.js';
import { DEFAULT_NOSTR_RELAYS } from '$lib/config.js';
import { KIND } from '$lib/types/nostr.js';
import type { NostrEvent } from '$lib/types/nostr.js';
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

    // Check if announcement was passed from search results via sessionStorage
    let announcement: NostrEvent | null = null;
    if (typeof window !== 'undefined') {
      const repoKey = `${npub}/${repo}`;
      const storedAnnouncement = sessionStorage.getItem(`repo_announcement_${repoKey}`);
      if (storedAnnouncement) {
        try {
          announcement = JSON.parse(storedAnnouncement);
          // Clean up after using it
          sessionStorage.removeItem(`repo_announcement_${repoKey}`);
        } catch {
          // Invalid JSON, continue to fetch
        }
      }
    }

    // If not found in sessionStorage, fetch from Nostr (case-insensitive)
    if (!announcement) {
      const nostrClient = new NostrClient(DEFAULT_NOSTR_RELAYS);
      // Fetch all announcements by this author and filter case-insensitively
      const allEvents = await nostrClient.fetchEvents([
        {
          kinds: [KIND.REPO_ANNOUNCEMENT],
          authors: [repoOwnerPubkey],
          limit: 100
        }
      ]);

      // Filter case-insensitively to find the matching repo
      const repoLower = repo.toLowerCase();
      const matchingEvents = allEvents.filter(event => {
        const dTag = event.tags.find(t => t[0] === 'd')?.[1];
        return dTag && dTag.toLowerCase() === repoLower;
      });

      if (matchingEvents.length === 0) {
        // Not found in Nostr relays - try reading from filesystem (server-side only)
        // This is important for private forks that weren't published to relays
        // Only attempt on server-side using SvelteKit's SSR flag
        if (import.meta.env.SSR) {
          try {
            // Dynamic import to prevent client-side bundling
            const fsModule = await import('./read-announcement-from-fs.js');
            const announcementFromRepo = await fsModule.readAnnouncementFromFilesystem(npub, repo, repoOwnerPubkey);
            if (announcementFromRepo) {
              announcement = announcementFromRepo;
            }
          } catch (err) {
            // If filesystem read fails, log on server-side but continue
            // This is expected on client-side, so we silently continue
            console.debug('Failed to read announcement from filesystem:', err);
          }
        }
        
        if (!announcement) {
          return {
            title: `${repo} - Repository Not Found`,
            description: 'Repository announcement not found',
            announcement: null, // Explicitly set to null so component knows it's missing
            repoNotFound: true // Flag to indicate repo not found
          };
        }
      } else {
        announcement = matchingEvents[0];
      }
    }
    
    // Ensure announcement exists before proceeding
    if (!announcement) {
      return {
        title: `${repo} - Repository Not Found`,
        description: 'Repository announcement not found',
        announcement: null,
        repoNotFound: true
      };
    }
    
    // Check privacy - for private repos, we'll let the API endpoints handle access control
    // The page load function runs server-side but doesn't have access to client auth headers
    // So we'll mark it as private and let the frontend handle access denial
    const maintainerService = new MaintainerService(DEFAULT_NOSTR_RELAYS);
    const isPrivate = announcement.tags.some((t: string[]) => 
      (t[0] === 'private' && t[1] === 'true') || 
      (t[0] === 't' && t[1] === 'private')
    );
    
    // For private repos, we can't check access here (no user context in page load)
    // The frontend will need to check access via API and show appropriate error
    // We still expose basic metadata (name) but the API will enforce access
    
    // Extract basic info for title/description (minimal extraction for metadata)
    const name = announcement.tags.find((t: string[]) => t[0] === 'name')?.[1] || repo;
    const description = announcement.tags.find((t: string[]) => t[0] === 'description')?.[1] || '';
    const image = announcement.tags.find((t: string[]) => t[0] === 'image')?.[1];
    const banner = announcement.tags.find((t: string[]) => t[0] === 'banner')?.[1];

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
      repoUrl,
      announcement: announcement, // Return full announcement - component can extract what it needs
      ogType: 'website'
    };
  } catch (error) {
    console.error('Error loading repository metadata:', error);
    return {
      title: `${repo} - Repository`,
      description: 'Repository',
      announcement: null, // Explicitly set to null on error
      repoNotFound: true, // Flag to indicate error
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
};
