/**
 * API endpoint for listing files and directories in a repository
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fileManager, repoManager, nostrClient } from '$lib/services/service-registry.js';
import { createRepoGetHandler } from '$lib/utils/api-handlers.js';
import type { RepoRequestContext, RequestEvent } from '$lib/utils/api-context.js';
import { handleApiError } from '$lib/utils/error-handler.js';
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
                { operation: 'listFiles', npub: context.npub, repo: context.repo },
                'Repository not found and could not be fetched from remote'
              );
            }
          }
        } else {
          throw handleApiError(
            new Error('Repository announcement not found in Nostr'),
            { operation: 'listFiles', npub: context.npub, repo: context.repo },
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
            { operation: 'listFiles', npub: context.npub, repo: context.repo },
            'Repository not found'
          );
        }
      }
    }

    const ref = context.ref || 'HEAD';
    const path = context.path || '';
    
    const files = await fileManager.listFiles(context.npub, context.repo, ref, path);
    return json(files);
  },
  { operation: 'listFiles', requireRepoExists: false, requireRepoAccess: false } // Handle on-demand fetching, tree is public
);
