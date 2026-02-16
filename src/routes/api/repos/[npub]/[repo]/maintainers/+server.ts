/**
 * API endpoint for checking maintainer status
 */

import { json, error } from '@sveltejs/kit';
// @ts-ignore - SvelteKit generates this type
import type { RequestHandler } from './$types';
import { MaintainerService } from '$lib/services/nostr/maintainer-service.js';
import { DEFAULT_NOSTR_RELAYS } from '$lib/config.js';
import { nip19 } from 'nostr-tools';

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
      const decoded = nip19.decode(npub);
      if (decoded.type === 'npub') {
        repoOwnerPubkey = decoded.data as string;
      } else {
        return error(400, 'Invalid npub format');
      }
    } catch {
      return error(400, 'Invalid npub format');
    }

    const { maintainers, owner } = await maintainerService.getMaintainers(repoOwnerPubkey, repo);

    // If userPubkey provided, check if they're a maintainer
    if (userPubkey) {
      let userPubkeyHex = userPubkey;
      try {
        // Try to decode if it's an npub
        const userDecoded = nip19.decode(userPubkey);
        // @ts-ignore - nip19 types are incomplete, but we know npub returns string
        if (userDecoded.type === 'npub') {
          userPubkeyHex = userDecoded.data as unknown as string;
        }
      } catch {
        // Assume it's already a hex pubkey
      }

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
    console.error('Error checking maintainers:', err);
    return error(500, err instanceof Error ? err.message : 'Failed to check maintainers');
  }
};
