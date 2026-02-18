/**
 * API endpoint for checking repository access
 * Returns whether the current user can view the repository
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { maintainerService } from '$lib/services/service-registry.js';
import { createRepoGetHandler } from '$lib/utils/api-handlers.js';
import type { RepoRequestContext } from '$lib/utils/api-context.js';

export const GET: RequestHandler = createRepoGetHandler(
  async (context: RepoRequestContext) => {
    const { isPrivate, maintainers, owner } = await maintainerService.getMaintainers(
      context.repoOwnerPubkey,
      context.repo
    );
    
    // Check if user can view
    const canView = await maintainerService.canView(
      context.userPubkeyHex || null,
      context.repoOwnerPubkey,
      context.repo
    );
    
    return json({
      canView,
      isPrivate,
      isMaintainer: context.userPubkeyHex ? maintainers.includes(context.userPubkeyHex) : false,
      isOwner: context.userPubkeyHex ? context.userPubkeyHex === owner : false
    });
  },
  { operation: 'checkAccess', requireRepoExists: false, requireRepoAccess: false } // This endpoint IS the access check
);
