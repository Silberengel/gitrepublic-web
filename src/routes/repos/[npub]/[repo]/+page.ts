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
    let foundInSessionStorage = false;
    if (typeof window !== 'undefined') {
      const repoKey = `${npub}/${repo}`;
      const storedAnnouncement = sessionStorage.getItem(`repo_announcement_${repoKey}`);
      if (storedAnnouncement) {
        try {
          announcement = JSON.parse(storedAnnouncement);
          foundInSessionStorage = true;
          console.log(`[Page Load] Found announcement in sessionStorage for ${npub}/${repo}`, { eventId: announcement?.id });
          // Don't remove it yet - keep it as fallback if server-side load fails
        } catch (err) {
          console.warn(`[Page Load] Failed to parse announcement from sessionStorage:`, err);
          // Invalid JSON, continue to fetch
        }
      } else {
        console.log(`[Page Load] No announcement in sessionStorage for ${npub}/${repo}`);
      }
    }

    // If not found in sessionStorage, fetch from Nostr (case-insensitive)
    if (!announcement) {
      try {
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
            // Retry filesystem read with exponential backoff (commit might still be in progress)
            let retries = 3;
            let delay = 500; // Start with 500ms delay
            while (retries > 0 && !announcement) {
              try {
                // Dynamic import to prevent client-side bundling
                // Wrap in additional try-catch to handle import errors gracefully
                try {
                  const fsModule = await import('./read-announcement-from-fs.js');
                  if (fsModule && typeof fsModule.readAnnouncementFromFilesystem === 'function') {
                    console.log(`[Page Load] Attempting to read announcement from filesystem for ${npub}/${repo} (${4 - retries}/3)`);
                    const announcementFromRepo = await fsModule.readAnnouncementFromFilesystem(npub, repo, repoOwnerPubkey);
                    if (announcementFromRepo) {
                      console.log(`[Page Load] Successfully read announcement from filesystem for ${npub}/${repo}`);
                      announcement = announcementFromRepo;
                      break; // Success, exit retry loop
                    } else {
                      console.log(`[Page Load] Announcement not found in filesystem for ${npub}/${repo}, retrying...`);
                    }
                  } else {
                    console.warn(`[Page Load] readAnnouncementFromFilesystem function not found in module`);
                    break; // Don't retry if function doesn't exist
                  }
                } catch (importError) {
                  // Handle import errors (e.g., Vite SSR circular dependency issues)
                  // Don't retry on import errors - they won't be fixed by waiting
                  console.error('[Page Load] Failed to import readAnnouncementFromFilesystem (Vite SSR issue):', importError);
                  break; // Exit retry loop on import errors
                }
              } catch (err) {
                // If filesystem read fails, log and retry
                console.error(`[Page Load] Failed to read announcement from filesystem (attempt ${4 - retries}/3):`, err);
              }
              
              if (!announcement && retries > 1) {
                // Wait before retrying (exponential backoff)
                await new Promise(resolve => setTimeout(resolve, delay));
                delay *= 2; // Double the delay for next retry
              }
              retries--;
            }
          } else {
            // Client-side: log that we're skipping filesystem read
            console.debug(`[Page Load] Skipping filesystem read (client-side) for ${npub}/${repo}`);
          }
        } else {
          announcement = matchingEvents[0];
        }
      } catch (nostrError) {
        // If Nostr fetch fails, log but continue - we might have it in sessionStorage or filesystem
        console.error('[Page Load] Failed to fetch from Nostr relays:', nostrError);
      }
    }
    
    // Clean up sessionStorage only if we successfully loaded from Nostr (public repos)
    // For private repos loaded from filesystem or sessionStorage, keep it for client-side navigation
    if (foundInSessionStorage && announcement && typeof window !== 'undefined') {
      // Check if we loaded from Nostr (not from sessionStorage or filesystem)
      // If the announcement came from Nostr, it means it's public and we don't need sessionStorage
      const repoKey = `${npub}/${repo}`;
      const stillInStorage = sessionStorage.getItem(`repo_announcement_${repoKey}`);
      
      // Only remove if we have the announcement AND it's not from sessionStorage (meaning we got it from Nostr)
      // This is a bit tricky: if foundInSessionStorage is true, we used sessionStorage, so don't remove it
      // We only want to remove if we found it in Nostr AFTER checking sessionStorage
      if (stillInStorage && !foundInSessionStorage) {
        // This shouldn't happen, but if it does, it means we loaded from Nostr
        sessionStorage.removeItem(`repo_announcement_${repoKey}`);
        console.log(`[Page Load] Removed announcement from sessionStorage (loaded from Nostr)`);
      } else if (foundInSessionStorage) {
        // Keep sessionStorage - we're using it and client-side can't read filesystem
        console.log(`[Page Load] Keeping announcement in sessionStorage (using it as source)`);
      }
    }
    
    // If still no announcement found, check sessionStorage one more time (client-side fallback)
    if (!announcement && !import.meta.env.SSR && typeof window !== 'undefined') {
      const repoKey = `${npub}/${repo}`;
      const lastChanceAnnouncement = sessionStorage.getItem(`repo_announcement_${repoKey}`);
      if (lastChanceAnnouncement) {
        try {
          announcement = JSON.parse(lastChanceAnnouncement);
          console.log(`[Page Load] Found announcement in sessionStorage on final check (client-side)`);
        } catch {
          // Invalid JSON
        }
      }
    }
    
    // If still no announcement found, don't immediately return "not found"
    // The repo might exist but announcement not found yet (e.g., private fork being committed)
    // Let the component check if repo exists via API before showing "not found"
    if (!announcement) {
      console.warn(`[Page Load] Announcement not found for ${npub}/${repo} after all attempts`, {
        foundInSessionStorage,
        isSSR: import.meta.env.SSR,
        hasWindow: typeof window !== 'undefined'
      });
      // Return announcement as null but don't set repoNotFound - let component verify repo exists
      return {
        title: `${repo} - Repository`,
        description: 'Repository',
        announcement: null, // Explicitly set to null so component knows it's missing
        repoNotFound: false // Don't assume repo doesn't exist - component will check
      };
    }
    
    console.log(`[Page Load] Successfully loaded announcement for ${npub}/${repo}`, {
      eventId: announcement.id,
      foundInSessionStorage,
      isSSR: import.meta.env.SSR
    });
    
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
    let gitDomain = url.host || 'localhost:6543';
    try {
      const layoutData = await parent();
      gitDomain = (layoutData as { gitDomain?: string }).gitDomain || gitDomain;
    } catch (parentError) {
      // If parent() fails (e.g., due to SSR issues), use fallback
      console.debug('Failed to get layout data, using fallback:', parentError);
    }
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
