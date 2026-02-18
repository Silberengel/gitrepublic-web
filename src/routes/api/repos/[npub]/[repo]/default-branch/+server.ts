/**
 * API endpoint for getting the default branch of a repository
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fileManager } from '$lib/services/service-registry.js';
import { createRepoGetHandler } from '$lib/utils/api-handlers.js';
import type { RepoRequestContext } from '$lib/utils/api-context.js';
import { handleApiError } from '$lib/utils/error-handler.js';

export const GET: RequestHandler = createRepoGetHandler(
  async (context: RepoRequestContext) => {
    try {
      const defaultBranch = await fileManager.getDefaultBranch(context.npub, context.repo);
      return json({ defaultBranch, branch: defaultBranch });
    } catch (error) {
      throw handleApiError(error, { operation: 'getDefaultBranch', npub: context.npub, repo: context.repo });
    }
  }
);
