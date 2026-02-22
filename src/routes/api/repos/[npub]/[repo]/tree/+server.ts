/**
 * API endpoint for listing files and directories in a repository
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fileManager, repoManager, nostrClient } from '$lib/services/service-registry.js';
import { createRepoGetHandler } from '$lib/utils/api-handlers.js';
import type { RepoRequestContext, RequestEvent } from '$lib/utils/api-context.js';
import { handleApiError, handleNotFoundError } from '$lib/utils/error-handler.js';
import { KIND } from '$lib/types/nostr.js';
import { join } from 'path';
import { existsSync } from 'fs';
import { repoCache, RepoCache } from '$lib/services/git/repo-cache.js';
import logger from '$lib/services/logger.js';
import { eventCache } from '$lib/services/nostr/event-cache.js';
import { fetchRepoAnnouncementsWithCache, findRepoAnnouncement } from '$lib/utils/nostr-utils.js';

const repoRoot = typeof process !== 'undefined' && process.env?.GIT_REPO_ROOT
  ? process.env.GIT_REPO_ROOT
  : '/repos';

export const GET: RequestHandler = createRepoGetHandler(
  async (context: RepoRequestContext) => {
    const repoPath = join(repoRoot, context.npub, `${context.repo}.git`);
    
    // If repo doesn't exist, try to fetch it on-demand
    if (!existsSync(repoPath)) {
      try {
        // Fetch repository announcement from Nostr (case-insensitive) with caching
        const allEvents = await fetchRepoAnnouncementsWithCache(nostrClient, context.repoOwnerPubkey, eventCache);
        const announcement = findRepoAnnouncement(allEvents, context.repo);

        if (announcement) {
          // Try API-based fetching first (no cloning)
          const { tryApiFetch } = await import('$lib/utils/api-repo-helper.js');
          const apiData = await tryApiFetch(announcement, context.npub, context.repo);
          
          if (apiData && apiData.files) {
            // Return API data directly without cloning
            const path = context.path || '';
            // Filter files by path if specified
            const filteredFiles = path 
              ? apiData.files.filter(f => f.path.startsWith(path))
              : apiData.files.filter(f => !f.path.includes('/') || f.path.split('/').length === 1);
            
            // Normalize type: API returns 'dir' but frontend expects 'directory'
            const normalizedFiles = filteredFiles.map(f => ({
              name: f.name,
              path: f.path,
              type: (f.type === 'dir' ? 'directory' : 'file') as 'file' | 'directory',
              size: f.size
            }));
            
            return json(normalizedFiles);
          }
          
          // API fetch failed - repo is not cloned and API fetch didn't work
          throw handleNotFoundError(
            'Repository is not cloned locally and could not be fetched via API. Privileged users can clone this repository using the "Clone to Server" button.',
            { operation: 'listFiles', npub: context.npub, repo: context.repo }
          );
        } else {
          throw handleNotFoundError(
            'Repository announcement not found in Nostr',
            { operation: 'listFiles', npub: context.npub, repo: context.repo }
          );
        }
      } catch (err) {
        // Check if repo was created by another concurrent request
        if (existsSync(repoPath)) {
          // Repo exists now, clear cache and continue with normal flow
          repoCache.delete(RepoCache.repoExistsKey(context.npub, context.repo));
        } else {
          // If fetching fails, return 404
          throw handleNotFoundError(
            'Repository not found',
            { operation: 'listFiles', npub: context.npub, repo: context.repo }
          );
        }
      }
    }

    // Double-check repo exists (should be true if we got here)
    if (!existsSync(repoPath)) {
      throw handleNotFoundError(
        'Repository not found',
        { operation: 'listFiles', npub: context.npub, repo: context.repo }
      );
    }

    // Get default branch if no ref specified
    let ref = context.ref || 'HEAD';
    // If ref is a branch name, validate it exists or use default branch
    if (ref !== 'HEAD' && !ref.startsWith('refs/')) {
      try {
        const branches = await fileManager.getBranches(context.npub, context.repo);
        if (!branches.includes(ref)) {
          // Branch doesn't exist, use default branch
          ref = await fileManager.getDefaultBranch(context.npub, context.repo);
        }
      } catch {
        // If we can't get branches, fall back to HEAD
        ref = 'HEAD';
      }
    }
    const path = context.path || '';
    
    try {
      const files = await fileManager.listFiles(context.npub, context.repo, ref, path);
      return json(files);
    } catch (err) {
      // Log the actual error for debugging
      logger.error({ error: err, npub: context.npub, repo: context.repo }, '[Tree] Error listing files');
      // Check if it's a "not found" error
      if (err instanceof Error && err.message.includes('not found')) {
        throw handleNotFoundError(
          err.message,
          { operation: 'listFiles', npub: context.npub, repo: context.repo }
        );
      }
      // Otherwise, it's a server error
      throw handleApiError(
        err,
        { operation: 'listFiles', npub: context.npub, repo: context.repo },
        'Failed to list files'
      );
    }
  },
  { operation: 'listFiles', requireRepoExists: false, requireRepoAccess: true } // Handle on-demand fetching, but check access for private repos
);
