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
import { join } from 'path';
import { existsSync } from 'fs';
import { repoCache, RepoCache } from '$lib/services/git/repo-cache.js';

const repoRoot = typeof process !== 'undefined' && process.env?.GIT_REPO_ROOT
  ? process.env.GIT_REPO_ROOT
  : '/repos';

export const GET: RequestHandler = createRepoGetHandler(
  async (context: RepoRequestContext) => {
    const repoPath = join(repoRoot, context.npub, `${context.repo}.git`);
    
    // If repo doesn't exist, try to fetch it on-demand
    if (!existsSync(repoPath)) {
      try {
        // Fetch repository announcement from Nostr
        const events = await nostrClient.fetchEvents([
          {
            kinds: [KIND.REPO_ANNOUNCEMENT],
            authors: [context.repoOwnerPubkey],
            '#d': [context.repo],
            limit: 1
          }
        ]);

        if (events.length > 0) {
          // Try to fetch the repository from remote clone URLs
          const fetched = await repoManager.fetchRepoOnDemand(
            context.npub,
            context.repo,
            events[0]
          );
          
          // Always check if repo exists after fetch attempt (might have been created)
          // Also clear cache to ensure fileManager sees it
          if (existsSync(repoPath)) {
            repoCache.delete(RepoCache.repoExistsKey(context.npub, context.repo));
            // Repo exists, continue with normal flow
          } else if (!fetched) {
            // Fetch failed and repo doesn't exist
            throw handleNotFoundError(
              'Repository not found and could not be fetched from remote. The repository may not have any accessible clone URLs.',
              { operation: 'getBranches', npub: context.npub, repo: context.repo }
            );
          } else {
            // Fetch returned true but repo doesn't exist - this shouldn't happen, but clear cache anyway
            repoCache.delete(RepoCache.repoExistsKey(context.npub, context.repo));
            // Wait a moment for filesystem to sync, then check again
            await new Promise(resolve => setTimeout(resolve, 100));
            if (!existsSync(repoPath)) {
              throw handleNotFoundError(
                'Repository fetch completed but repository is not accessible',
                { operation: 'getBranches', npub: context.npub, repo: context.repo }
              );
            }
          }
        } else {
          throw handleNotFoundError(
            'Repository announcement not found in Nostr',
            { operation: 'getBranches', npub: context.npub, repo: context.repo }
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
            { operation: 'getBranches', npub: context.npub, repo: context.repo }
          );
        }
      }
    }

    // Double-check repo exists after on-demand fetch
    if (!existsSync(repoPath)) {
      throw handleNotFoundError(
        'Repository not found',
        { operation: 'getBranches', npub: context.npub, repo: context.repo }
      );
    }

    try {
      const branches = await fileManager.getBranches(context.npub, context.repo);
      return json(branches);
    } catch (err) {
      // Log the actual error for debugging
      console.error('[Branches] Error getting branches:', err);
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
  { operation: 'getBranches', requireRepoExists: false, requireRepoAccess: false } // Branches are public info, handle on-demand fetching
);

export const POST: RequestHandler = createRepoPostHandler(
  async (context: RepoRequestContext, event: RequestEvent) => {
    const body = await event.request.json();
    const { branchName, fromBranch } = body;

    if (!branchName) {
      throw handleValidationError('Missing branchName parameter', { operation: 'createBranch', npub: context.npub, repo: context.repo });
    }

    await fileManager.createBranch(context.npub, context.repo, branchName, fromBranch || 'main');
    return json({ success: true, message: 'Branch created successfully' });
  },
  { operation: 'createBranch' }
);
