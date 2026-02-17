/**
 * API endpoint for checking maintainer status
 */

import { json, error } from '@sveltejs/kit';
// @ts-ignore - SvelteKit generates this type
import type { RequestHandler } from './$types';
import { MaintainerService } from '$lib/services/nostr/maintainer-service.js';
import { DEFAULT_NOSTR_RELAYS } from '$lib/config.js';
import { nip19 } from 'nostr-tools';
import { requireNpubHex, decodeNpubToHex } from '$lib/utils/npub-utils.js';
import { handleApiError, handleValidationError } from '$lib/utils/error-handler.js';

const maintainerService = new MaintainerService(DEFAULT_NOSTR_RELAYS);

export const GET: RequestHandler = async ({ params, url }: { params: { npub?: string; repo?: string }; url: URL }) => {
  const { npub, repo } = params;
  const userPubkey = url.searchParams.get('userPubkey');

  if (!npub || !repo) {
    return handleValidationError('Missing npub or repo parameter', { operation: 'getMaintainers' });
  }

  try {
    // Convert npub to pubkey
    let repoOwnerPubkey: string;
    try {
      repoOwnerPubkey = requireNpubHex(npub);
    } catch {
      return handleValidationError('Invalid npub format', { operation: 'getMaintainers', npub });
    }

    const { maintainers, owner } = await maintainerService.getMaintainers(repoOwnerPubkey, repo);

    // If userPubkey provided, check if they're a maintainer
    if (userPubkey) {
      const userPubkeyHex = decodeNpubToHex(userPubkey) || userPubkey;

      const isMaintainer = maintainers.includes(userPubkeyHex);
      return json({ 
        maintainers, 
        owner, 
        isMaintainer,
        userPubkey: userPubkeyHex 
      });
    }

    return json({ maintainers, owner });
  } catch (err) {
    return handleApiError(err, { operation: 'getMaintainers', npub, repo }, 'Failed to check maintainers');
  }
};
