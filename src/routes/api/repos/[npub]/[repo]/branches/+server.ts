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
import { DEFAULT_NOSTR_RELAYS, DEFAULT_NOSTR_SEARCH_RELAYS } from '$lib/config.js';
import { NostrClient } from '$lib/services/nostr/nostr-client.js';
import { eventCache } from '$lib/services/nostr/event-cache.js';

const repoRoot = typeof process !== 'undefined' && process.env?.GIT_REPO_ROOT
  ? process.env.GIT_REPO_ROOT
  : '/repos';

export const GET: RequestHandler = createRepoGetHandler(
  async (context: RepoRequestContext) => {
    const repoPath = join(repoRoot, context.npub, `${context.repo}.git`);
    
    // If repo doesn't exist, try to fetch it on-demand
    if (!existsSync(repoPath)) {
      try {
        // Try cached client first (cache-first lookup)
        const filters = [
          {
            kinds: [KIND.REPO_ANNOUNCEMENT],
            authors: [context.repoOwnerPubkey],
            '#d': [context.repo],
            limit: 1
          }
        ];
        
        let events = await nostrClient.fetchEvents(filters);
        
        // If no events found in cache/default relays, try all relays (default + search)
        // But first invalidate the cache entry so we don't get the same cached empty result
        if (events.length === 0) {
          const allRelays = [...new Set([...DEFAULT_NOSTR_RELAYS, ...DEFAULT_NOSTR_SEARCH_RELAYS])];
          // Only create new client if we have additional relays to try
          if (allRelays.length > DEFAULT_NOSTR_RELAYS.length) {
            // Invalidate the cache entry so we can try fresh with all relays
            eventCache.invalidate(filters);
            const allRelaysClient = new NostrClient(allRelays);
            events = await allRelaysClient.fetchEvents(filters);
          }
        }

        if (events.length > 0) {
          // Try API-based fetching first (no cloning)
          const { tryApiFetch } = await import('$lib/utils/api-repo-helper.js');
          const apiData = await tryApiFetch(events[0], context.npub, context.repo);
          
          if (apiData) {
            // Return API data directly without cloning
            return json(apiData.branches);
          }
          
          // API fetch failed - repo is not cloned and API fetch didn't work
          // Return 404 with helpful message suggesting to clone
          throw handleNotFoundError(
            'Repository is not cloned locally and could not be fetched via API. Privileged users can clone this repository using the "Clone to Server" button.',
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
          console.error('[Branches] Error fetching repository:', err);
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
  { operation: 'getBranches', requireRepoExists: false, requireRepoAccess: true } // Handle on-demand fetching, but check access for private repos
);

export const POST: RequestHandler = createRepoPostHandler(
  async (context: RepoRequestContext, event: RequestEvent) => {
    const body = await event.request.json();
    const { branchName, fromBranch } = body;

    if (!branchName) {
      throw handleValidationError('Missing branchName parameter', { operation: 'createBranch', npub: context.npub, repo: context.repo });
    }

    // Get default branch if fromBranch not provided
    const sourceBranch = fromBranch || await fileManager.getDefaultBranch(context.npub, context.repo);
    await fileManager.createBranch(context.npub, context.repo, branchName, sourceBranch);
    return json({ success: true, message: 'Branch created successfully' });
  },
  { operation: 'createBranch' }
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
