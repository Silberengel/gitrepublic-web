/**
 * API endpoint for getting and creating tags
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
