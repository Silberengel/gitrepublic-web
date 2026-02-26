/**
 * API endpoint for verifying commit signatures
 */

import { json } from '@sveltejs/kit';
// @ts-ignore - SvelteKit generates this type
import type { RequestHandler } from './$types';
import { createRepoGetHandler } from '$lib/utils/api-handlers.js';
import type { RepoRequestContext, RequestEvent } from '$lib/utils/api-context.js';
import { handleApiError } from '$lib/utils/error-handler.js';
import { nostrClient, fileManager } from '$lib/services/service-registry.js';
import { verifyCommitFromMessage } from '$lib/services/git/commit-signer.js';
import simpleGit from 'simple-git';
import { join } from 'path';

const repoRoot = typeof process !== 'undefined' && process.env?.GIT_REPO_ROOT
  ? process.env.GIT_REPO_ROOT
  : '/repos';

export const GET: RequestHandler = createRepoGetHandler(
  async (context: RepoRequestContext, event: RequestEvent) => {
    const { hash } = event.params;
    
    if (!hash) {
      throw handleApiError(new Error('Missing commit hash'), { operation: 'verifyCommit', npub: context.npub, repo: context.repo }, 'Missing commit hash');
    }

    const repoPath = join(repoRoot, context.npub, `${context.repo}.git`);

    try {
      // Get commit message from git
      const git = simpleGit(repoPath);
      const commit = await git.show([hash, '--format=%B', '--no-patch']);
      
      if (!commit) {
        throw handleApiError(new Error('Commit not found'), { operation: 'verifyCommit', npub: context.npub, repo: context.repo }, 'Commit not found');
      }

      // Verify the commit signature
      // Check .jsonl file first, then fall back to relays
      const verification = await verifyCommitFromMessage(
        commit, 
        hash, 
        nostrClient,
        fileManager,
        context.npub,
        context.repo
      );

      return json(verification);
    } catch (err) {
      throw handleApiError(err, { operation: 'verifyCommit', npub: context.npub, repo: context.repo }, 'Failed to verify commit');
    }
  },
  { operation: 'verifyCommit', requireRepoExists: true, requireRepoAccess: false }
);
