/**
 * API endpoint for getting and creating tags
 */

import { json } from '@sveltejs/kit';
// @ts-ignore - SvelteKit generates this type
import type { RequestHandler } from './$types';
import { fileManager } from '$lib/services/service-registry.js';
import { createRepoGetHandler, createRepoPostHandler } from '$lib/utils/api-handlers.js';
import type { RepoRequestContext, RequestEvent } from '$lib/utils/api-context.js';
import { handleValidationError, handleNotFoundError } from '$lib/utils/error-handler.js';
import { join } from 'path';
import { existsSync } from 'fs';

const repoRoot = typeof process !== 'undefined' && process.env?.GIT_REPO_ROOT
  ? process.env.GIT_REPO_ROOT
  : '/repos';

export const GET: RequestHandler = createRepoGetHandler(
  async (context: RepoRequestContext) => {
    const repoPath = join(repoRoot, context.npub, `${context.repo}.git`);
    
    // If repo doesn't exist locally, return empty tags array
    // Tags are only available for locally cloned repositories
    if (!existsSync(repoPath)) {
      return json([]);
    }
    
    const tags = await fileManager.getTags(context.npub, context.repo);
    return json(tags);
  },
  { operation: 'getTags', requireRepoExists: false, requireRepoAccess: true } // Handle on-demand fetching, but check access for private repos
);

export const POST: RequestHandler = createRepoPostHandler(
  async (context: RepoRequestContext, event: RequestEvent) => {
    const body = await event.request.json();
    const { tagName, ref, message } = body;

    if (!tagName) {
      throw handleValidationError('Missing tagName parameter', { operation: 'createTag', npub: context.npub, repo: context.repo });
    }

    await fileManager.createTag(context.npub, context.repo, tagName, ref || 'HEAD', message);
    return json({ success: true, message: 'Tag created successfully' });
  },
  { operation: 'createTag' }
);
