/**
 * API endpoint for merging Pull Requests
 */

import { json } from '@sveltejs/kit';
// @ts-ignore - SvelteKit generates this type
import type { RequestHandler } from './$types';
import { withRepoValidation } from '$lib/utils/api-handlers.js';
import type { RepoRequestContext } from '$lib/utils/api-context.js';
import { handleValidationError, handleApiError } from '$lib/utils/error-handler.js';
import { prsService, repoManager, fileManager, maintainerService } from '$lib/services/service-registry.js';
import { simpleGit } from 'simple-git';
import { join } from 'path';
import { existsSync } from 'fs';
import logger from '$lib/services/logger.js';
import { isValidBranchName } from '$lib/utils/security.js';
import { validatePubkey } from '$lib/utils/input-validation.js';

const repoRoot = typeof process !== 'undefined' && process.env?.GIT_REPO_ROOT
  ? process.env.GIT_REPO_ROOT
  : '/repos';

export const POST: RequestHandler = withRepoValidation(
  async ({ repoContext, requestContext, event }) => {
    const body = await event.request.json();
    const { prId, prAuthor, prCommitId, targetBranch = 'main', mergeMessage } = body;

    // Validate required fields
    if (!prId || typeof prId !== 'string' || prId.length !== 64) {
      throw handleValidationError('Invalid prId: must be a 64-character hex string', { operation: 'mergePR', npub: repoContext.npub, repo: repoContext.repo });
    }

    if (!prAuthor || typeof prAuthor !== 'string') {
      throw handleValidationError('Invalid prAuthor: must be a string', { operation: 'mergePR', npub: repoContext.npub, repo: repoContext.repo });
    }

    // Validate pubkey format
    const pubkeyValidation = validatePubkey(prAuthor);
    if (!pubkeyValidation.valid) {
      throw handleValidationError(`Invalid prAuthor: ${pubkeyValidation.error}`, { operation: 'mergePR', npub: repoContext.npub, repo: repoContext.repo });
    }

    if (!prCommitId || typeof prCommitId !== 'string' || prCommitId.length !== 40) {
      throw handleValidationError('Invalid prCommitId: must be a 40-character commit hash', { operation: 'mergePR', npub: repoContext.npub, repo: repoContext.repo });
    }

    // Validate branch name
    if (!isValidBranchName(targetBranch)) {
      throw handleValidationError(`Invalid branch name: ${targetBranch}`, { operation: 'mergePR', npub: repoContext.npub, repo: repoContext.repo });
    }

    // Validate merge message if provided
    if (mergeMessage && (typeof mergeMessage !== 'string' || mergeMessage.length > 10000)) {
      throw handleValidationError('Invalid mergeMessage: must be a string with max 10000 characters', { operation: 'mergePR', npub: repoContext.npub, repo: repoContext.repo });
    }

    // Check if user is maintainer
    const isMaintainer = await maintainerService.isMaintainer(requestContext.userPubkeyHex || '', repoContext.repoOwnerPubkey, repoContext.repo);
    
    if (!isMaintainer && requestContext.userPubkeyHex !== repoContext.repoOwnerPubkey) {
      throw handleApiError(new Error('Only repository owners and maintainers can merge PRs'), { operation: 'mergePR', npub: repoContext.npub, repo: repoContext.repo }, 'Unauthorized');
    }

    // Check if repo exists locally
    const repoPath = join(repoRoot, repoContext.npub, `${repoContext.repo}.git`);
    if (!existsSync(repoPath)) {
      throw handleApiError(new Error('Repository not cloned locally. Please clone the repository first.'), { operation: 'mergePR', npub: repoContext.npub, repo: repoContext.repo }, 'Repository not found');
    }

    // Get user info for commit
    const authorName = requestContext.userName || 'GitRepublic User';
    const authorEmail = requestContext.userEmail || `${requestContext.userPubkeyHex?.slice(0, 20)}@gitrepublic.web`;

    try {
      const git = simpleGit(repoPath);
      
      // Fetch latest changes
      await git.fetch(['origin']).catch(() => {}); // Ignore errors if no remote
      
      // Checkout target branch
      await git.checkout(targetBranch);
      
      // Merge the PR commit
      const mergeMessageText = mergeMessage || `Merge pull request ${prId.slice(0, 7)}`;
      await git.merge([prCommitId, '--no-ff', '-m', mergeMessageText]);
      
      // Get the merge commit ID
      const mergeCommitId = (await git.revparse(['HEAD'])).trim();
      
      // Update PR status to merged
      const statusEvent = await prsService.updatePRStatus(
        prId,
        prAuthor,
        repoContext.repoOwnerPubkey,
        repoContext.repo,
        'merged',
        mergeCommitId
      );

      return json({ 
        success: true, 
        mergeCommitId,
        statusEvent 
      });
    } catch (err) {
      logger.error({ error: err, npub: repoContext.npub, repo: repoContext.repo, prId, prCommitId }, 'Error merging PR');
      throw handleApiError(err instanceof Error ? err : new Error('Failed to merge PR'), { operation: 'mergePR', npub: repoContext.npub, repo: repoContext.repo }, 'Failed to merge pull request');
    }
  },
  { operation: 'mergePR', requireRepoAccess: true }
);
