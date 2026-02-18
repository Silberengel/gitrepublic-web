/**
 * Helper utilities for API-based repository fetching
 * Used by endpoints to fetch repo metadata without cloning
 */

import { fetchRepoMetadata, extractGitUrls } from '../services/git/api-repo-fetcher.js';
import type { NostrEvent } from '../types/nostr.js';
import logger from '../services/logger.js';

/**
 * Try to fetch repository metadata via API from clone URLs
 * Returns null if API fetching fails or no clone URLs available
 */
export async function tryApiFetch(
  announcementEvent: NostrEvent,
  npub: string,
  repoName: string
): Promise<{
  branches: Array<{ name: string; commit: { sha: string; message: string; author: string; date: string } }>;
  defaultBranch: string;
  files?: Array<{ name: string; path: string; type: 'file' | 'dir'; size?: number }>;
  commits?: Array<{ sha: string; message: string; author: string; date: string }>;
} | null> {
  try {
    const cloneUrls = extractGitUrls(announcementEvent);
    
    if (cloneUrls.length === 0) {
      logger.debug({ npub, repoName }, 'No clone URLs found for API fetch');
      return null;
    }

    // Try each clone URL until one works
    for (const url of cloneUrls) {
      try {
        const metadata = await fetchRepoMetadata(url, npub, repoName);
        
        if (metadata) {
          return {
            branches: metadata.branches,
            defaultBranch: metadata.defaultBranch,
            files: metadata.files,
            commits: metadata.commits
          };
        }
      } catch (err) {
        logger.debug({ error: err, url, npub, repoName }, 'API fetch failed for URL, trying next');
        continue;
      }
    }

    return null;
  } catch (err) {
    logger.warn({ error: err, npub, repoName }, 'Error attempting API fetch');
    return null;
  }
}
