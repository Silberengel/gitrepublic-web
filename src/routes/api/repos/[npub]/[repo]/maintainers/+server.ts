/**
 * API endpoint for checking maintainer status
 */

import { json } from '@sveltejs/kit';
// @ts-ignore - SvelteKit generates this type
import type { RequestHandler } from './$types';
import { maintainerService } from '$lib/services/service-registry.js';
import { createRepoGetHandler } from '$lib/utils/api-handlers.js';
import type { RepoRequestContext } from '$lib/utils/api-context.js';

export const GET: RequestHandler = createRepoGetHandler(
  async (context: RepoRequestContext) => {
    const { maintainers, owner } = await maintainerService.getMaintainers(context.repoOwnerPubkey, context.repo);

    // If userPubkey provided, check if they're a maintainer
    // SECURITY: Do NOT leak userPubkey in response - only return boolean status
    if (context.userPubkeyHex) {
      const isMaintainer = maintainers.includes(context.userPubkeyHex);
      return json({ 
        maintainers, 
        owner, 
        isMaintainer
        // SECURITY: Removed userPubkey leak - client already knows their own pubkey
      });
    }

    return json({ maintainers, owner });
  },
  { operation: 'getMaintainers', requireRepoExists: false, requireRepoAccess: false } // Maintainer list is public info, doesn't need repo to exist
);
