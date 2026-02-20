/**
 * API endpoint for updating Pull Requests (kind 1619)
 */

import { json } from '@sveltejs/kit';
// @ts-ignore - SvelteKit generates this type
import type { RequestHandler } from './$types';
import { withRepoValidation } from '$lib/utils/api-handlers.js';
import type { RepoRequestContext } from '$lib/utils/api-context.js';
import { handleValidationError, handleApiError } from '$lib/utils/error-handler.js';
import { DEFAULT_NOSTR_RELAYS } from '$lib/config.js';
import { prsService } from '$lib/services/service-registry.js';
import { getGitUrl } from '$lib/config.js';

export const POST: RequestHandler = withRepoValidation(
  async ({ repoContext, requestContext, event }) => {
    const body = await event.request.json();
    const { prId, prAuthor, newCommitId, mergeBase } = body;

    if (!prId || !prAuthor || !newCommitId) {
      throw handleValidationError('Missing required fields: prId, prAuthor, newCommitId', { operation: 'updatePR', npub: repoContext.npub, repo: repoContext.repo });
    }

    // Only PR author can update their PR
    if (requestContext.userPubkeyHex !== prAuthor) {
      throw handleApiError(new Error('Only the PR author can update the PR'), { operation: 'updatePR', npub: repoContext.npub, repo: repoContext.repo }, 'Unauthorized');
    }

    const cloneUrl = getGitUrl(repoContext.npub, repoContext.repo);
    const updateEvent = await prsService.updatePullRequest(
      prId,
      prAuthor,
      repoContext.repoOwnerPubkey,
      repoContext.repo,
      newCommitId,
      cloneUrl,
      mergeBase
    );

    return json({ success: true, event: updateEvent });
  },
  { operation: 'updatePR', requireRepoAccess: false }
);
