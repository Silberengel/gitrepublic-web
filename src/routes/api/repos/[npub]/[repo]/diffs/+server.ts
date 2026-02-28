/**
 * RESTful Diffs Endpoint
 * 
 * GET /api/repos/{npub}/{repo}/diffs?from=...&to=...&path=...
 * 
 * Query parameters:
 *   - from - Source ref (required)
 *   - to - Target ref (default: HEAD)
 *   - path - Optional file path to diff
 */

import { json } from '@sveltejs/kit';
// @ts-ignore - SvelteKit generates this type
import type { RequestHandler } from './$types';
import { fileManager, nostrClient } from '$lib/services/service-registry.js';
import { createRepoGetHandler } from '$lib/utils/api-handlers.js';
import type { RepoRequestContext, RequestEvent } from '$lib/utils/api-context.js';
import { handleValidationError, handleNotFoundError } from '$lib/utils/error-handler.js';
import { join } from 'path';
import { existsSync } from 'fs';
import { eventCache } from '$lib/services/nostr/event-cache.js';
import { fetchRepoAnnouncementsWithCache, findRepoAnnouncement } from '$lib/utils/nostr-utils.js';
import logger from '$lib/services/logger.js';

const repoRoot = typeof process !== 'undefined' && process.env?.GIT_REPO_ROOT
  ? process.env.GIT_REPO_ROOT
  : '/repos';

export const GET: RequestHandler = createRepoGetHandler(
  async (context: RepoRequestContext, event: RequestEvent) => {
    const fromRef = event.url.searchParams.get('from');
    const toRef = event.url.searchParams.get('to') || 'HEAD';
    const filePath = event.url.searchParams.get('path') || undefined;

    if (!fromRef) {
      throw handleValidationError('Missing from parameter', { operation: 'getDiff', npub: context.npub, repo: context.repo });
    }

    const repoPath = join(repoRoot, context.npub, `${context.repo}.git`);
    
    // Check if repo exists
    if (!existsSync(repoPath)) {
      // Repo doesn't exist - diffs are not available via API fallback
      // GitHub/GitLab APIs don't provide easy diff endpoints
      logger.debug({ npub: context.npub, repo: context.repo, fromRef, toRef }, 'Diff requested for non-existent repo');
      throw handleNotFoundError(
        'Repository is not cloned locally. Diffs are only available for cloned repositories. Please clone the repository to view diffs.',
        { operation: 'getDiff', npub: context.npub, repo: context.repo }
      );
    }

    try {
      const diffs = await fileManager.getDiff(context.npub, context.repo, fromRef, toRef, filePath);
      return json(diffs);
    } catch (err) {
      // If error occurs, check if repo is empty
      logger.debug({ error: err, npub: context.npub, repo: context.repo, fromRef, toRef }, 'Error getting diff, checking if repo is empty');
      
      try {
        // Check if repo has any branches
        const branches = await fileManager.getBranches(context.npub, context.repo);
        if (branches.length === 0) {
          // Repo is empty - diffs not available
          throw handleNotFoundError(
            'Repository is empty. Diffs are only available for repositories with commits.',
            { operation: 'getDiff', npub: context.npub, repo: context.repo }
          );
        }
      } catch (branchErr) {
        // If we can't get branches, the repo might be empty or corrupted
        logger.debug({ error: branchErr, npub: context.npub, repo: context.repo }, 'Failed to get branches, repo may be empty');
      }
      
      // Re-throw the original error with better context
      const errorMessage = err instanceof Error ? err.message : 'Failed to get diff';
      if (errorMessage.includes('not found') || errorMessage.includes('Invalid object name')) {
        throw handleNotFoundError(
          `Commit not found: ${errorMessage}. The commit hash may be invalid or the repository may not have the requested commits.`,
          { operation: 'getDiff', npub: context.npub, repo: context.repo }
        );
      }
      
      throw err;
    }
  },
  { operation: 'getDiff', requireRepoExists: false, requireRepoAccess: true }
);
