/**
 * API endpoint for getting and creating repository branches
 */

import { json, error } from '@sveltejs/kit';
// @ts-ignore - SvelteKit generates this type
import type { RequestHandler } from './$types';
import { fileManager, repoManager, nostrClient } from '$lib/services/service-registry.js';
import { createRepoGetHandler, createRepoPostHandler } from '$lib/utils/api-handlers.js';
import type { RepoRequestContext, RequestEvent } from '$lib/utils/api-context.js';
import { handleValidationError, handleApiError, handleNotFoundError } from '$lib/utils/error-handler.js';
import { KIND } from '$lib/types/nostr.js';
import { join, dirname } from 'path';
import { existsSync, accessSync, constants } from 'fs';
import { repoCache, RepoCache } from '$lib/services/git/repo-cache.js';
import { DEFAULT_NOSTR_RELAYS, DEFAULT_NOSTR_SEARCH_RELAYS } from '$lib/config.js';
import { NostrClient } from '$lib/services/nostr/nostr-client.js';
import { eventCache } from '$lib/services/nostr/event-cache.js';
import { fetchRepoAnnouncementsWithCache, findRepoAnnouncement } from '$lib/utils/nostr-utils.js';
import { isGraspUrl } from '$lib/services/git/api-repo-fetcher.js';
import logger from '$lib/services/logger.js';

/**
 * Check if a directory exists and is writable
 * Provides helpful error messages for container environments
 */
function checkDirectoryWritable(dirPath: string, description: string): void {
  if (!existsSync(dirPath)) {
    const isContainer = existsSync('/.dockerenv') || process.env.DOCKER_CONTAINER === 'true';
    const errorMsg = isContainer
      ? `${description} does not exist at ${dirPath}. In Docker, ensure the volume is mounted correctly and the directory exists on the host. Check docker-compose.yml volumes section.`
      : `${description} does not exist at ${dirPath}`;
    throw new Error(errorMsg);
  }
  
  try {
    accessSync(dirPath, constants.W_OK);
  } catch (accessErr) {
    const isContainer = existsSync('/.dockerenv') || process.env.DOCKER_CONTAINER === 'true';
    const errorMsg = isContainer
      ? `${description} at ${dirPath} is not writable. In Docker, check that the volume mount has correct permissions. The container runs as user 'gitrepublic' (UID 1001). Ensure the host directory is writable by this user or adjust ownership: chown -R 1001:1001 ./repos`
      : `${description} at ${dirPath} is not writable`;
    throw new Error(errorMsg);
  }
}

const repoRoot = typeof process !== 'undefined' && process.env?.GIT_REPO_ROOT
  ? process.env.GIT_REPO_ROOT
  : '/repos';

export const GET: RequestHandler = createRepoGetHandler(
  async (context: RepoRequestContext, event: RequestEvent) => {
    const repoPath = join(repoRoot, context.npub, `${context.repo}.git`);
    const skipApiFallback = event.url.searchParams.get('skipApiFallback') === 'true';
    
    // If repo doesn't exist, try to fetch it on-demand (unless skipApiFallback is true)
    if (!existsSync(repoPath)) {
      // If skipApiFallback is true, return 404 immediately to indicate repo is not cloned
      if (skipApiFallback) {
        throw handleNotFoundError(
          'Repository is not cloned locally',
          { operation: 'getBranches', npub: context.npub, repo: context.repo }
        );
      }
      try {
        // Fetch repository announcement (case-insensitive) with caching
        let allEvents = await fetchRepoAnnouncementsWithCache(nostrClient, context.repoOwnerPubkey, eventCache);
        let announcement = findRepoAnnouncement(allEvents, context.repo);
        
        // If no events found in cache/default relays, try all relays (default + search)
        if (!announcement) {
          const allRelays = [...new Set([...DEFAULT_NOSTR_RELAYS, ...DEFAULT_NOSTR_SEARCH_RELAYS])];
          // Only create new client if we have additional relays to try
          if (allRelays.length > DEFAULT_NOSTR_RELAYS.length) {
            const allRelaysClient = new NostrClient(allRelays);
            allEvents = await fetchRepoAnnouncementsWithCache(allRelaysClient, context.repoOwnerPubkey, eventCache);
            announcement = findRepoAnnouncement(allEvents, context.repo);
          }
        }
        
        const events = announcement ? [announcement] : [];

        if (events.length > 0) {
          // Try API-based fetching first (no cloning)
          const { tryApiFetch } = await import('$lib/utils/api-repo-helper.js');
          const { extractCloneUrls } = await import('$lib/utils/nostr-utils.js');
          const cloneUrls = extractCloneUrls(events[0]);
          
          logger.debug({ npub: context.npub, repo: context.repo, cloneUrlCount: cloneUrls.length, cloneUrls }, 'Attempting API fallback for branches');
          
          const apiData = await tryApiFetch(events[0], context.npub, context.repo);
          
          if (apiData && apiData.branches && apiData.branches.length > 0) {
            logger.debug({ npub: context.npub, repo: context.repo, branchCount: apiData.branches.length }, 'Successfully fetched branches via API fallback');
            // Sort branches: default branch first, then alphabetically
            const sortedBranches = [...apiData.branches];
            if (apiData.defaultBranch) {
              sortedBranches.sort((a: any, b: any) => {
                const aName = typeof a === 'string' ? a : a.name;
                const bName = typeof b === 'string' ? b : b.name;
                if (aName === apiData.defaultBranch) return -1;
                if (bName === apiData.defaultBranch) return 1;
                return aName.localeCompare(bName);
              });
            }
            return json(sortedBranches);
          }
          
          // API fetch failed - repo is not cloned and API fetch didn't work
          // Check if we have clone URLs to provide better error message
          const hasCloneUrls = cloneUrls.length > 0;
          logger.warn({ 
            npub: context.npub, 
            repo: context.repo, 
            hasCloneUrls, 
            cloneUrlCount: cloneUrls.length,
            cloneUrls: cloneUrls.slice(0, 3) // Log first 3 URLs for debugging
          }, 'API fallback failed for branches - repo not cloned and API fetch unsuccessful');
          
          // Provide more detailed error message
          const cloneUrlTypes = cloneUrls.map(url => {
            if (url.includes('github.com')) return 'GitHub';
            if (url.includes('gitlab.com') || url.includes('gitlab')) return 'GitLab';
            if (url.includes('gitea')) return 'Gitea';
            if (isGraspUrl(url)) return 'GRASP';
            return 'Unknown';
          });
          
          throw handleNotFoundError(
            hasCloneUrls
              ? `Repository is not cloned locally and could not be fetched via API from external clone URLs (${cloneUrlTypes.join(', ')}). This may be due to API rate limits, network issues, or the repository being private. Privileged users can clone this repository using the "Clone to Server" button.`
              : 'Repository is not cloned locally and has no external clone URLs for API fallback. Privileged users can clone this repository using the "Clone to Server" button.',
            { operation: 'getBranches', npub: context.npub, repo: context.repo }
          );
        } else {
          // No events found - could be because:
          // 1. Repository doesn't exist
          // 2. Relays are unreachable
          // 3. Repository is on different relays
          throw handleNotFoundError(
            'Repository announcement not found in Nostr. This could mean: (1) the repository does not exist, (2) the configured Nostr relays are unreachable, or (3) the repository is published on different relays. Try configuring additional relays via the NOSTR_RELAYS environment variable.',
            { operation: 'getBranches', npub: context.npub, repo: context.repo }
          );
        }
      } catch (err) {
        // Check if repo was created by another concurrent request
        if (existsSync(repoPath)) {
          // Repo exists now, clear cache and continue with normal flow
          repoCache.delete(RepoCache.repoExistsKey(context.npub, context.repo));
        } else {
          // Log the error for debugging
          logger.error({ error: err, npub: context.npub, repo: context.repo }, '[Branches] Error fetching repository');
          // If fetching fails, return 404 with more context
          const errorMessage = err instanceof Error ? err.message : 'Repository not found';
          throw handleNotFoundError(
            errorMessage,
            { operation: 'getBranches', npub: context.npub, repo: context.repo }
          );
        }
      }
    }

    // Double-check repo exists (should be true if we got here)
    if (!existsSync(repoPath)) {
      throw handleNotFoundError(
        'Repository not found',
        { operation: 'getBranches', npub: context.npub, repo: context.repo }
      );
    }

    try {
      const branches = await fileManager.getBranches(context.npub, context.repo);
      
      // If repo exists but has no branches (empty repo), try API fallback
      if (branches.length === 0) {
        logger.debug({ npub: context.npub, repo: context.repo }, 'Repo exists but is empty, attempting API fallback');
        
        try {
          // Fetch repository announcement for API fallback
          let allEvents = await fetchRepoAnnouncementsWithCache(nostrClient, context.repoOwnerPubkey, eventCache);
          let announcement = findRepoAnnouncement(allEvents, context.repo);
          
          // If no events found in cache/default relays, try all relays (default + search)
          if (!announcement) {
            const allRelays = [...new Set([...DEFAULT_NOSTR_RELAYS, ...DEFAULT_NOSTR_SEARCH_RELAYS])];
            if (allRelays.length > DEFAULT_NOSTR_RELAYS.length) {
              const allRelaysClient = new NostrClient(allRelays);
              allEvents = await fetchRepoAnnouncementsWithCache(allRelaysClient, context.repoOwnerPubkey, eventCache);
              announcement = findRepoAnnouncement(allEvents, context.repo);
            }
          }
          
          if (announcement) {
            const { tryApiFetch } = await import('$lib/utils/api-repo-helper.js');
            const { extractCloneUrls } = await import('$lib/utils/nostr-utils.js');
            const cloneUrls = extractCloneUrls(announcement);
            
            logger.debug({ npub: context.npub, repo: context.repo, cloneUrlCount: cloneUrls.length }, 'Attempting API fallback for empty repo');
            
            const apiData = await tryApiFetch(announcement, context.npub, context.repo);
            
            if (apiData && apiData.branches && apiData.branches.length > 0) {
              logger.info({ npub: context.npub, repo: context.repo, branchCount: apiData.branches.length }, 'Successfully fetched branches via API fallback for empty repo');
              // Sort branches: default branch first, then alphabetically
              const sortedBranches = [...apiData.branches];
              if (apiData.defaultBranch) {
                sortedBranches.sort((a: any, b: any) => {
                  const aName = typeof a === 'string' ? a : a.name;
                  const bName = typeof b === 'string' ? b : b.name;
                  if (aName === apiData.defaultBranch) return -1;
                  if (bName === apiData.defaultBranch) return 1;
                  return aName.localeCompare(bName);
                });
              }
              return json(sortedBranches);
            }
          }
        } catch (apiErr) {
          logger.debug({ error: apiErr, npub: context.npub, repo: context.repo }, 'API fallback failed for empty repo, returning empty branches');
        }
      }
      
      // Sort branches: default branch first, then alphabetically
      let sortedBranches = [...branches];
      try {
        const defaultBranch = await fileManager.getDefaultBranch(context.npub, context.repo);
        if (defaultBranch) {
          sortedBranches.sort((a: any, b: any) => {
            const aName = typeof a === 'string' ? a : a.name;
            const bName = typeof b === 'string' ? b : b.name;
            if (aName === defaultBranch) return -1;
            if (bName === defaultBranch) return 1;
            return aName.localeCompare(bName);
          });
        } else {
          // No default branch found, just sort alphabetically
          sortedBranches.sort((a: any, b: any) => {
            const aName = typeof a === 'string' ? a : a.name;
            const bName = typeof b === 'string' ? b : b.name;
            return aName.localeCompare(bName);
          });
        }
      } catch {
        // If we can't get default branch, just sort alphabetically
        sortedBranches.sort((a: any, b: any) => {
          const aName = typeof a === 'string' ? a : a.name;
          const bName = typeof b === 'string' ? b : b.name;
          return aName.localeCompare(bName);
        });
      }
      
      return json(sortedBranches);
    } catch (err) {
      // Log the actual error for debugging
      logger.error({ error: err, npub: context.npub, repo: context.repo }, '[Branches] Error getting branches');
      // Check if it's a "not found" error
      if (err instanceof Error && err.message.includes('not found')) {
        throw handleNotFoundError(
          err.message,
          { operation: 'getBranches', npub: context.npub, repo: context.repo }
        );
      }
      // Otherwise, it's a server error
      throw handleApiError(
        err,
        { operation: 'getBranches', npub: context.npub, repo: context.repo },
        'Failed to get branches'
      );
    }
  },
  { operation: 'getBranches', requireRepoExists: false, requireRepoAccess: true } // Handle on-demand fetching, but check access for private repos
);

export const POST: RequestHandler = createRepoPostHandler(
  async (context: RepoRequestContext, event: RequestEvent) => {
    const body = await event.request.json();
    const { branchName, fromBranch, announcement } = body;

    if (!branchName) {
      throw handleValidationError('Missing branchName parameter', { operation: 'createBranch', npub: context.npub, repo: context.repo });
    }

    const repoPath = join(repoRoot, context.npub, `${context.repo}.git`);
    const repoExists = existsSync(repoPath);

    // Create repo if it doesn't exist
    if (!repoExists) {
      logger.info({ npub: context.npub, repo: context.repo }, 'Creating new empty repository for branch creation');
      const { mkdir } = await import('fs/promises');
      
      // Check if repoRoot exists and is writable (with helpful container error messages)
      if (!existsSync(repoRoot)) {
        try {
          await mkdir(repoRoot, { recursive: true });
          logger.debug({ repoRoot }, 'Created repoRoot directory');
        } catch (rootErr) {
          logger.error({ error: rootErr, repoRoot }, 'Failed to create repoRoot directory');
          // Check if parent directory is writable
          const parentRoot = dirname(repoRoot);
          if (existsSync(parentRoot)) {
            try {
              checkDirectoryWritable(parentRoot, 'Parent directory of GIT_REPO_ROOT');
            } catch (checkErr) {
              throw handleApiError(
                checkErr,
                { operation: 'createBranch', npub: context.npub, repo: context.repo },
                checkErr instanceof Error ? checkErr.message : String(checkErr)
              );
            }
          }
          throw handleApiError(
            rootErr,
            { operation: 'createBranch', npub: context.npub, repo: context.repo },
            `Failed to create repository root directory: ${rootErr instanceof Error ? rootErr.message : String(rootErr)}`
          );
        }
      } else {
        // Directory exists, check if it's writable
        try {
          checkDirectoryWritable(repoRoot, 'GIT_REPO_ROOT directory');
        } catch (checkErr) {
          throw handleApiError(
            checkErr,
            { operation: 'createBranch', npub: context.npub, repo: context.repo },
            checkErr instanceof Error ? checkErr.message : String(checkErr)
          );
        }
      }
      
      // Create repo directory
      const repoDir = dirname(repoPath);
      try {
        await mkdir(repoDir, { recursive: true });
        logger.debug({ repoDir }, 'Created repository directory');
      } catch (dirErr) {
        logger.error({ error: dirErr, repoDir, npub: context.npub, repo: context.repo }, 'Failed to create repository directory');
        throw handleApiError(
          dirErr,
          { operation: 'createBranch', npub: context.npub, repo: context.repo },
          `Failed to create repository directory: ${dirErr instanceof Error ? dirErr.message : String(dirErr)}`
        );
      }
      
      // Initialize bare repository
      try {
        const simpleGit = (await import('simple-git')).default;
        const git = simpleGit();
        await git.init(['--bare', repoPath]);
        logger.info({ npub: context.npub, repo: context.repo }, 'Empty repository created successfully');
      } catch (initErr) {
        logger.error({ error: initErr, repoPath, npub: context.npub, repo: context.repo }, 'Failed to initialize bare repository');
        throw handleApiError(
          initErr,
          { operation: 'createBranch', npub: context.npub, repo: context.repo },
          `Failed to initialize repository: ${initErr instanceof Error ? initErr.message : String(initErr)}`
        );
      }
    }

    // Check if repo has any branches first
    let hasBranches = false;
    try {
      const existingBranches = await fileManager.getBranches(context.npub, context.repo);
      hasBranches = existingBranches.length > 0;
    } catch (err) {
      // If getBranches fails, assume no branches exist
      logger.debug({ error: err, npub: context.npub, repo: context.repo }, 'Failed to get branches, assuming empty repo');
      hasBranches = false;
    }

    // Get default branch if fromBranch not provided and repo has branches
    // If repo has no branches, don't pass fromBranch (will use --orphan)
    let sourceBranch = fromBranch;
    if (!sourceBranch && hasBranches) {
      try {
        sourceBranch = await fileManager.getDefaultBranch(context.npub, context.repo);
      } catch (err) {
        // If getDefaultBranch fails, use 'main' as default (only if branches exist)
        logger.debug({ error: err, npub: context.npub, repo: context.repo }, 'No default branch found, using main');
        sourceBranch = 'main';
      }
    }
    // If repo has no branches, sourceBranch will be undefined/null, which createBranch will handle correctly
    
    await fileManager.createBranch(context.npub, context.repo, branchName, sourceBranch);
    return json({ success: true, message: 'Branch created successfully' });
  },
  { operation: 'createBranch', requireRepoExists: false } // Allow creating branches in empty repos
);

export const DELETE: RequestHandler = createRepoPostHandler(
  async (context: RepoRequestContext, event: RequestEvent) => {
    const body = await event.request.json();
    const { branchName } = body;

    if (!branchName) {
      throw handleValidationError('Missing branchName parameter', { operation: 'deleteBranch', npub: context.npub, repo: context.repo });
    }

    await fileManager.deleteBranch(context.npub, context.repo, branchName);
    return json({ success: true, message: 'Branch deleted successfully' });
  },
  { operation: 'deleteBranch' }
);
