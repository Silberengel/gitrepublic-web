/**
 * API endpoint for getting commit history
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fileManager } from '$lib/services/service-registry.js';
import { createRepoGetHandler } from '$lib/utils/api-handlers.js';
import type { RepoRequestContext } from '$lib/utils/api-context.js';

export const GET: RequestHandler = createRepoGetHandler(
  async (context: RepoRequestContext) => {
    const branch = context.branch || 'main';
    const limit = context.limit || 50;
    const path = context.path;
    
    const commits = await fileManager.getCommitHistory(context.npub, context.repo, branch, limit, path);
    return json(commits);
  },
  { operation: 'getCommits' }
);
