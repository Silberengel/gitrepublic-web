/**
 * RESTful Pull Request Merge Endpoint
 * 
 * POST /api/repos/{npub}/{repo}/pull-requests/{id}/merge
 * 
 * Merges a pull request. Only maintainers and owners can merge PRs.
 */

import { json } from '@sveltejs/kit';
// @ts-ignore - SvelteKit generates this type
import type { RequestHandler } from './$types';
import { fileManager, nostrClient, prsService } from '$lib/services/service-registry.js';
import { withRepoValidation } from '$lib/utils/api-handlers.js';
import type { RepoRequestContext, RequestEvent } from '$lib/utils/api-context.js';
import { handleValidationError, handleApiError } from '$lib/utils/error-handler.js';
import { DEFAULT_NOSTR_RELAYS } from '$lib/config.js';
import { MaintainerService } from '$lib/services/nostr/maintainer-service.js';
import { KIND } from '$lib/types/nostr.js';
import logger from '$lib/services/logger.js';
import { join } from 'path';
import { existsSync } from 'fs';
import { simpleGit } from 'simple-git';

const repoRoot = typeof process !== 'undefined' && process.env?.GIT_REPO_ROOT
  ? process.env.GIT_REPO_ROOT
  : '/repos';

export const POST: RequestHandler = withRepoValidation(
  async ({ repoContext, requestContext, event }) => {
    const id = (event.params as any).id;
    const body = await event.request.json();
    const { targetBranch = 'main', mergeCommitMessage, mergeStrategy = 'merge' } = body;

    if (!id) {
      throw handleValidationError('Missing pull request ID', { operation: 'mergePullRequest', npub: repoContext.npub, repo: repoContext.repo });
    }

    // Check if user is maintainer or owner
    const maintainerService = new MaintainerService(DEFAULT_NOSTR_RELAYS);
    const isMaintainer = await maintainerService.isMaintainer(requestContext.userPubkeyHex || '', repoContext.repoOwnerPubkey, repoContext.repo);
    
    if (!isMaintainer && requestContext.userPubkeyHex !== repoContext.repoOwnerPubkey) {
      throw handleApiError(new Error('Only repository owners and maintainers can merge pull requests'), { operation: 'mergePullRequest', npub: repoContext.npub, repo: repoContext.repo }, 'Unauthorized');
    }

    const repoPath = join(repoRoot, repoContext.npub, `${repoContext.repo}.git`);
    
    if (!existsSync(repoPath)) {
      throw handleApiError(new Error('Repository not found locally'), { operation: 'mergePullRequest', npub: repoContext.npub, repo: repoContext.repo }, 'Repository not found');
    }

    try {
      // Fetch the PR event
      const prEvents = await nostrClient.fetchEvents([
        {
          kinds: [KIND.PULL_REQUEST],
          ids: [id],
          limit: 1
        }
      ]);

      if (prEvents.length === 0) {
        throw handleApiError(new Error('Pull request not found'), { operation: 'mergePullRequest', npub: repoContext.npub, repo: repoContext.repo }, 'Pull request not found');
      }

      const prEvent = prEvents[0];
      
      // Get commit ID from PR
      const commitTag = prEvent.tags.find(t => t[0] === 'c');
      if (!commitTag || !commitTag[1]) {
        throw handleApiError(new Error('Pull request does not have a commit ID'), { operation: 'mergePullRequest', npub: repoContext.npub, repo: repoContext.repo }, 'Invalid pull request');
      }

      const commitId = commitTag[1];
      
      // Get branch name if available
      const branchTag = prEvent.tags.find(t => t[0] === 'branch-name');
      const sourceBranch = branchTag?.[1] || `pr-${id.substring(0, 8)}`;

      const git = simpleGit(repoPath);

      // Checkout target branch
      await git.checkout(targetBranch);

      // Fetch the commit (in case it's from a remote)
      try {
        await git.fetch(['--all']);
      } catch (fetchErr) {
        logger.debug({ error: fetchErr }, 'Fetch failed, continuing with local merge');
      }

      // Check if commit exists
      try {
        await git.show([commitId]);
      } catch (showErr) {
        throw handleApiError(new Error(`Commit ${commitId} not found in repository`), { operation: 'mergePullRequest', npub: repoContext.npub, repo: repoContext.repo }, 'Commit not found');
      }

      let mergeCommitHash: string;

      if (mergeStrategy === 'squash') {
        // Squash merge: create a single commit with all changes
        await git.raw(['merge', '--squash', commitId]);
        await git.add('.');
        
        const finalMessage = mergeCommitMessage || `Merge PR ${id.substring(0, 8)}\n\n${prEvent.content || ''}`;
        await git.commit(finalMessage);
        
        mergeCommitHash = (await git.revparse(['HEAD'])).trim();
      } else if (mergeStrategy === 'rebase') {
        // Rebase merge: rebase the PR branch onto target branch
        // First, create a temporary branch from the commit
        const tempBranch = `temp-merge-${Date.now()}`;
        await git.checkout(['-b', tempBranch, commitId]);
        
        // Rebase onto target branch
        await git.rebase([targetBranch]);
        
        // Switch back to target branch and merge
        await git.checkout(targetBranch);
        await git.merge([tempBranch, '--no-ff']);
        
        mergeCommitHash = (await git.revparse(['HEAD'])).trim();
        
        // Clean up temporary branch
        try {
          await git.branch(['-D', tempBranch]);
        } catch (cleanupErr) {
          logger.warn({ error: cleanupErr }, 'Failed to delete temporary branch');
        }
      } else {
        // Regular merge
        const finalMessage = mergeCommitMessage || `Merge PR ${id.substring(0, 8)}`;
        await git.merge([commitId, '-m', finalMessage]);
        mergeCommitHash = (await git.revparse(['HEAD'])).trim();
      }

      // Update PR status to merged
      const prAuthor = prEvent.pubkey;
      await prsService.updatePRStatus(
        id,
        prAuthor,
        repoContext.repoOwnerPubkey,
        repoContext.repo,
        'merged',
        mergeCommitHash
      );

      return json({ 
        success: true, 
        commitHash: mergeCommitHash,
        message: 'Pull request merged successfully'
      });
    } catch (err) {
      logger.error({ error: err, npub: repoContext.npub, repo: repoContext.repo, id }, 'Error merging pull request');
      throw err;
    }
  },
  { operation: 'mergePullRequest', requireRepoExists: true, requireRepoAccess: true }
);
