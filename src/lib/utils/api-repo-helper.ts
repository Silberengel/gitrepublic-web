/**
 * Helper utilities for API-based repository fetching
 * Used by endpoints to fetch repo metadata without cloning
 */

import { fetchRepoMetadata, parseGitUrl } from '../services/git/api-repo-fetcher.js';
import { extractCloneUrls } from './nostr-utils.js';
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
  tags?: Array<{ name: string; sha: string; message?: string; date?: string }>;
} | null> {
  try {
    const cloneUrls = extractCloneUrls(announcementEvent);
    
    if (cloneUrls.length === 0) {
      logger.debug({ npub, repoName }, 'No clone URLs found for API fetch');
      return null;
    }

    // Convert SSH URLs to HTTPS URLs for API fetching
    const convertedUrls = cloneUrls.map(url => {
      if (url.startsWith('git@')) {
        // Convert SSH URL to HTTPS: git@host.com:owner/repo.git -> https://host.com/owner/repo.git
        const sshMatch = url.match(/^git@([^:]+):(.+)$/);
        if (sshMatch) {
          const [, host, path] = sshMatch;
          const httpsUrl = `https://${host}/${path}`;
          logger.debug({ sshUrl: url, httpsUrl }, 'Converted SSH URL to HTTPS for API fetch');
          return httpsUrl;
        }
        logger.warn({ url }, 'Unable to convert SSH URL to HTTPS, skipping');
        return null;
      }
      return url;
    }).filter((url): url is string => url !== null && (url.startsWith('http://') || url.startsWith('https://')));
    
    if (convertedUrls.length === 0) {
      logger.debug({ npub, repoName, totalUrls: cloneUrls.length, sshUrls: cloneUrls.filter(url => url.startsWith('git@')).length }, 'No usable clone URLs found for API fetch after conversion');
      return null;
    }

    logger.debug({ npub, repoName, totalUrls: cloneUrls.length, convertedUrls: convertedUrls.length, originalHttpUrls: cloneUrls.filter(url => url.startsWith('http')).length, sshUrls: cloneUrls.filter(url => url.startsWith('git@')).length }, 'Converted clone URLs for API fetch');

    // Prioritize GRASP servers (they use Gitea-compatible API)
    // Sort URLs: GRASP URLs first, then others
    const { isGraspUrl } = await import('../services/git/api-repo-fetcher.js');
    const sortedUrls = [...convertedUrls].sort((a, b) => {
      const aIsGrasp = isGraspUrl(a);
      const bIsGrasp = isGraspUrl(b);
      if (aIsGrasp && !bIsGrasp) return -1;
      if (!aIsGrasp && bIsGrasp) return 1;
      return 0;
    });
    
    logger.info({ 
      npub, 
      repoName, 
      totalUrls: sortedUrls.length,
      graspUrls: sortedUrls.filter(url => isGraspUrl(url)).length,
      urls: sortedUrls.map((url, idx) => ({ index: idx + 1, url, isGrasp: isGraspUrl(url) }))
    }, 'Starting API fetch attempts - will try each URL until one succeeds');

    // Try each clone URL until one works (GRASP URLs first)
    for (let i = 0; i < sortedUrls.length; i++) {
      const url = sortedUrls[i];
      try {
        logger.info({ url, npub, repoName, isGrasp: isGraspUrl(url), attempt: i + 1, total: sortedUrls.length }, `[${i + 1}/${sortedUrls.length}] Attempting to fetch repo metadata from URL`);
        const metadata = await fetchRepoMetadata(url, npub, repoName);
        
        if (metadata) {
          logger.info({ 
            url, 
            npub, 
            repoName, 
            platform: metadata.platform,
            branchCount: metadata.branches?.length || 0,
            fileCount: metadata.files?.length || 0,
            hasDefaultBranch: !!metadata.defaultBranch,
            attempt: i + 1,
            total: sortedUrls.length
          }, 'Successfully fetched repo metadata via API');
          
          // Return data even if some fields are empty (at least we got something)
          return {
            branches: metadata.branches || [],
            defaultBranch: metadata.defaultBranch || 'main',
            files: metadata.files || [],
            commits: metadata.commits || [],
            tags: metadata.tags || []
          };
        } else {
          logger.warn({ url, npub, repoName, attempt: i + 1, total: sortedUrls.length }, `[${i + 1}/${sortedUrls.length}] fetchRepoMetadata returned null, trying next URL`);
        }
      } catch (err) {
        logger.warn({ 
          error: err instanceof Error ? err.message : String(err), 
          errorStack: err instanceof Error ? err.stack : undefined,
          url, 
          npub, 
          repoName,
          attempt: i + 1,
          total: sortedUrls.length
        }, `[${i + 1}/${sortedUrls.length}] API fetch threw error for URL, trying next`);
        // Continue to next URL
      }
      
      // Add a small delay between attempts to avoid hammering APIs (except after the last attempt)
      if (i < sortedUrls.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500)); // 500ms delay
      }
    }
    
    logger.warn({ npub, repoName, totalUrls: sortedUrls.length, urls: sortedUrls }, 'All API fetch attempts failed for all clone URLs');

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
    const cloneUrls = extractCloneUrls(announcementEvent);
    
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
            // Use Buffer on server-side, atob on client-side
            let content: string;
            if (isServerSide()) {
              content = Buffer.from(fileData.content.replace(/\s/g, ''), 'base64').toString('utf-8');
            } else {
              content = atob(fileData.content.replace(/\s/g, ''));
            }
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
