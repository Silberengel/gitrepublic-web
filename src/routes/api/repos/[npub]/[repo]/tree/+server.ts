/**
 * API endpoint for listing files and directories in a repository
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fileManager } from '$lib/services/service-registry.js';
import { createRepoGetHandler } from '$lib/utils/api-handlers.js';
import type { RepoRequestContext, RequestEvent } from '$lib/utils/api-context.js';

export const GET: RequestHandler = createRepoGetHandler(
  async (context: RepoRequestContext) => {
    const ref = context.ref || 'HEAD';
    const path = context.path || '';
    
    const files = await fileManager.listFiles(context.npub, context.repo, ref, path);
    return json(files);
  },
  { operation: 'listFiles' }
);
