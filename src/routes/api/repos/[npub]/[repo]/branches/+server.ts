/**
 * API endpoint for getting and creating repository branches
 */

import { json } from '@sveltejs/kit';
// @ts-ignore - SvelteKit generates this type
import type { RequestHandler } from './$types';
import { fileManager } from '$lib/services/service-registry.js';
import { createRepoGetHandler, createRepoPostHandler } from '$lib/utils/api-handlers.js';
import type { RepoRequestContext, RequestEvent } from '$lib/utils/api-context.js';
import { handleValidationError } from '$lib/utils/error-handler.js';

export const GET: RequestHandler = createRepoGetHandler(
  async (context: RepoRequestContext) => {
    const branches = await fileManager.getBranches(context.npub, context.repo);
    return json(branches);
  },
  { operation: 'getBranches', requireRepoAccess: false } // Branches are public info
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
