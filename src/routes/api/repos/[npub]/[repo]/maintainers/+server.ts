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
import logger from '$lib/services/logger.js';

const maintainerService = new MaintainerService(DEFAULT_NOSTR_RELAYS);

export const GET: RequestHandler = async ({ params, url }: { params: { npub?: string; repo?: string }; url: URL }) => {
  const { npub, repo } = params;
  const userPubkey = url.searchParams.get('userPubkey');

  if (!npub || !repo) {
    return error(400, 'Missing npub or repo parameter');
  }

  try {
    // Convert npub to pubkey
    let repoOwnerPubkey: string;
    try {
      repoOwnerPubkey = requireNpubHex(npub);
    } catch {
      return error(400, 'Invalid npub format');
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
    logger.error({ error: err, npub, repo }, 'Error checking maintainers');
    return error(500, err instanceof Error ? err.message : 'Failed to check maintainers');
  }
};
