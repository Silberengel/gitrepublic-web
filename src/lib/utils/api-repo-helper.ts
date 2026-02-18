/**
 * Helper utilities for API-based repository fetching
 * Used by endpoints to fetch repo metadata without cloning
 */

import { fetchRepoMetadata, extractGitUrls, parseGitUrl } from '../services/git/api-repo-fetcher.js';
import type { NostrEvent } from '../types/nostr.js';
import logger from '../services/logger.js';

/**
 * Check if we're running on the server (Node.js) or client (browser)
 */
function isServerSide(): boolean {
  return typeof process !== 'undefined' && process.versions?.node !== undefined;
}

/**
 * Get the base URL for API requests
 * On server-side, call APIs directly. On client-side, use proxy to avoid CORS.
 */
function getApiBaseUrl(apiPath: string, baseUrl: string, searchParams: URLSearchParams): string {
  if (isServerSide()) {
    // Server-side: call API directly
    const cleanBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    const cleanApiPath = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
    const queryString = searchParams.toString();
    return `${cleanBaseUrl}${cleanApiPath}${queryString ? `?${queryString}` : ''}`;
  } else {
    // Client-side: use proxy to avoid CORS
    const queryString = new URLSearchParams({
      baseUrl,
      ...Object.fromEntries(searchParams.entries())
    }).toString();
    return `/api/gitea-proxy/${apiPath}?${queryString}`;
  }
}

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

/**
 * Try to fetch a single file via API from clone URLs
 * Returns null if API fetching fails or no clone URLs available
 */
export async function tryApiFetchFile(
  announcementEvent: NostrEvent,
  npub: string,
  repoName: string,
  filePath: string,
  ref: string = 'main'
): Promise<{ content: string; encoding: string } | null> {
  try {
    const cloneUrls = extractGitUrls(announcementEvent);
    
    if (cloneUrls.length === 0) {
      logger.debug({ npub, repoName, filePath }, 'No clone URLs found for API file fetch');
      return null;
    }

    // Try each clone URL until one works
    for (const url of cloneUrls) {
      try {
        const parsed = parseGitUrl(url);
        if (!parsed) {
          continue;
        }

        const { platform, owner, repo, baseUrl } = parsed;
        const encodedOwner = encodeURIComponent(owner);
        const encodedRepo = encodeURIComponent(repo);
        const encodedRef = encodeURIComponent(ref);
        
        // URL-encode the file path segments
        const encodedFilePath = filePath.split('/').map(segment => encodeURIComponent(segment)).join('/');

        let fileUrl: string;
        
        if (platform === 'gitea') {
          // Gitea: /api/v1/repos/{owner}/{repo}/contents/{path}?ref={ref}
          fileUrl = getApiBaseUrl(
            `repos/${encodedOwner}/${encodedRepo}/contents/${encodedFilePath}`,
            baseUrl,
            new URLSearchParams({ ref: encodedRef })
          );
        } else if (platform === 'gitlab') {
          // GitLab: /api/v4/projects/{owner}%2F{repo}/repository/files/{path}/raw?ref={ref}
          const projectPath = encodeURIComponent(`${owner}/${repo}`);
          fileUrl = getApiBaseUrl(
            `projects/${projectPath}/repository/files/${encodedFilePath}/raw`,
            baseUrl,
            new URLSearchParams({ ref: encodedRef })
          );
        } else if (platform === 'github') {
          // GitHub: /repos/{owner}/{repo}/contents/{path}?ref={ref}
          fileUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${encodedFilePath}?ref=${encodedRef}`;
        } else {
          // Unsupported platform
          continue;
        }

        const response = await fetch(fileUrl);
        
        if (!response.ok) {
          if (response.status === 404) {
            // File not found, try next URL
            continue;
          }
          logger.debug({ status: response.status, url, filePath }, 'API file fetch failed');
          continue;
        }

        const fileData = await response.json();
        
        // Handle different response formats
        if (platform === 'gitea' || platform === 'github') {
          // Gitea and GitHub return base64 encoded content
          if (fileData.content) {
            const content = atob(fileData.content.replace(/\s/g, ''));
            return {
              content,
              encoding: 'base64'
            };
          }
        } else if (platform === 'gitlab') {
          // GitLab raw endpoint returns plain text
          const content = await response.text();
          return {
            content,
            encoding: 'text'
          };
        }
      } catch (err) {
        logger.debug({ error: err, url, filePath }, 'API file fetch failed for URL, trying next');
        continue;
      }
    }

    return null;
  } catch (err) {
    logger.warn({ error: err, npub, repoName, filePath }, 'Error attempting API file fetch');
    return null;
  }
}
