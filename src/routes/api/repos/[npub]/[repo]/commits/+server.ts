/**
 * API endpoint for getting commit history
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fileManager, repoManager, nostrClient } from '$lib/services/service-registry.js';
import { createRepoGetHandler } from '$lib/utils/api-handlers.js';
import type { RepoRequestContext } from '$lib/utils/api-context.js';
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
          
          if (apiData && apiData.commits) {
            // Return API data directly without cloning
            const limit = context.limit || 50;
            return json(apiData.commits.slice(0, limit));
          }
          
          // API fetch failed - repo is not cloned and API fetch didn't work
          throw handleNotFoundError(
            'Repository is not cloned locally and could not be fetched via API. Privileged users can clone this repository using the "Clone to Server" button.',
            { operation: 'getCommits', npub: context.npub, repo: context.repo }
          );
        } else {
          throw handleNotFoundError(
            'Repository announcement not found in Nostr',
            { operation: 'getCommits', npub: context.npub, repo: context.repo }
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
            { operation: 'getCommits', npub: context.npub, repo: context.repo }
          );
        }
      }
    }

    // Double-check repo exists (should be true if we got here)
    if (!existsSync(repoPath)) {
      throw handleNotFoundError(
        'Repository not found',
        { operation: 'getCommits', npub: context.npub, repo: context.repo }
      );
    }

    // Get default branch if not specified
    let branch = context.branch;
    if (!branch) {
      try {
        branch = await fileManager.getDefaultBranch(context.npub, context.repo);
      } catch {
        branch = 'main'; // Fallback
      }
    }
    const limit = context.limit || 50;
    const path = context.path;
    
    try {
      const commits = await fileManager.getCommitHistory(context.npub, context.repo, branch, limit, path);
      
      // If repo exists but has no commits (empty repo), try API fallback
      if (commits.length === 0) {
        logger.debug({ npub: context.npub, repo: context.repo, branch }, 'Repo exists but is empty, attempting API fallback for commits');
        
        try {
          const allEvents = await fetchRepoAnnouncementsWithCache(nostrClient, context.repoOwnerPubkey, eventCache);
          const announcement = findRepoAnnouncement(allEvents, context.repo);
          
          if (announcement) {
            const { tryApiFetch } = await import('$lib/utils/api-repo-helper.js');
            const apiData = await tryApiFetch(announcement, context.npub, context.repo);
            
            if (apiData && apiData.commits && apiData.commits.length > 0) {
              logger.info({ npub: context.npub, repo: context.repo, commitCount: apiData.commits.length }, 'Successfully fetched commits via API fallback for empty repo');
              return json(apiData.commits.slice(0, limit));
            }
          }
        } catch (apiErr) {
          logger.debug({ error: apiErr, npub: context.npub, repo: context.repo }, 'API fallback failed for empty repo, returning empty commits');
        }
      }
      
      return json(commits);
    } catch (err) {
      // If error occurs, try API fallback before giving up
      logger.debug({ error: err, npub: context.npub, repo: context.repo }, '[Commits] Error getting commit history, attempting API fallback');
      
      try {
        const allEvents = await fetchRepoAnnouncementsWithCache(nostrClient, context.repoOwnerPubkey, eventCache);
        const announcement = findRepoAnnouncement(allEvents, context.repo);
        
        if (announcement) {
          const { tryApiFetch } = await import('$lib/utils/api-repo-helper.js');
          const apiData = await tryApiFetch(announcement, context.npub, context.repo);
          
          if (apiData && apiData.commits && apiData.commits.length > 0) {
            logger.info({ npub: context.npub, repo: context.repo, commitCount: apiData.commits.length }, 'Successfully fetched commits via API fallback after error');
            return json(apiData.commits.slice(0, limit));
          }
        }
      } catch (apiErr) {
        logger.debug({ error: apiErr, npub: context.npub, repo: context.repo }, 'API fallback failed after error');
      }
      
      // Log the actual error for debugging
      logger.error({ error: err, npub: context.npub, repo: context.repo }, '[Commits] Error getting commit history');
      // Check if it's a "not found" error
      if (err instanceof Error && err.message.includes('not found')) {
        throw handleNotFoundError(
          err.message,
          { operation: 'getCommits', npub: context.npub, repo: context.repo }
        );
      }
      // Otherwise, it's a server error
      throw handleApiError(
        err,
        { operation: 'getCommits', npub: context.npub, repo: context.repo },
        'Failed to get commit history'
      );
    }
  },
  { operation: 'getCommits', requireRepoExists: false, requireRepoAccess: true } // Handle on-demand fetching, but check access for private repos
);
