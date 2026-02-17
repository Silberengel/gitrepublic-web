/**
 * API endpoint for getting and creating repository branches
 */

import { json, error } from '@sveltejs/kit';
// @ts-ignore - SvelteKit generates this type
import type { RequestHandler } from './$types';
import { fileManager, repoManager, nostrClient } from '$lib/services/service-registry.js';
import { createRepoGetHandler, createRepoPostHandler } from '$lib/utils/api-handlers.js';
import type { RepoRequestContext, RequestEvent } from '$lib/utils/api-context.js';
import { handleValidationError, handleApiError } from '$lib/utils/error-handler.js';
import { KIND } from '$lib/types/nostr.js';
import { join } from 'path';
import { existsSync } from 'fs';

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
          
          if (!fetched) {
            // Check if repo exists now (might have been created by another request)
            if (existsSync(repoPath)) {
              // Repo was created, continue
            } else {
              throw handleApiError(
                new Error('Repository not found and could not be fetched from remote. The repository may not have any accessible clone URLs.'),
                { operation: 'getBranches', npub: context.npub, repo: context.repo },
                'Repository not found and could not be fetched from remote'
              );
            }
          }
        } else {
          throw handleApiError(
            new Error('Repository announcement not found in Nostr'),
            { operation: 'getBranches', npub: context.npub, repo: context.repo },
            'Repository announcement not found'
          );
        }
      } catch (err) {
        // Check if repo was created by another concurrent request
        if (existsSync(repoPath)) {
          // Repo exists now, continue with normal flow
        } else {
          // If fetching fails, return 404
          throw handleApiError(
            err instanceof Error ? err : new Error('Failed to fetch repository'),
            { operation: 'getBranches', npub: context.npub, repo: context.repo },
            'Repository not found'
          );
        }
      }
    }

    const branches = await fileManager.getBranches(context.npub, context.repo);
    return json(branches);
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
