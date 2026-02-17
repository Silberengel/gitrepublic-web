/**
 * API endpoint for getting diffs
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fileManager } from '$lib/services/service-registry.js';
import { createRepoGetHandler } from '$lib/utils/api-handlers.js';
import type { RepoRequestContext, RequestEvent } from '$lib/utils/api-context.js';
import { handleValidationError } from '$lib/utils/error-handler.js';

export const GET: RequestHandler = createRepoGetHandler(
  async (context: RepoRequestContext, event: RequestEvent) => {
    const fromRef = event.url.searchParams.get('from');
    const toRef = event.url.searchParams.get('to') || 'HEAD';
    const filePath = event.url.searchParams.get('path') || undefined;

    if (!fromRef) {
      throw handleValidationError('Missing from parameter', { operation: 'getDiff', npub: context.npub, repo: context.repo });
    }

    const diffs = await fileManager.getDiff(context.npub, context.repo, fromRef, toRef, filePath);
    return json(diffs);
  },
  { operation: 'getDiff' }
);
