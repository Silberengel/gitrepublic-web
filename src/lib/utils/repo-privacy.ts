/**
 * Helper utilities for checking repository privacy
 */

import { nip19 } from 'nostr-tools';
import { MaintainerService } from '../services/nostr/maintainer-service.js';
import { DEFAULT_NOSTR_RELAYS } from '../config.js';

const maintainerService = new MaintainerService(DEFAULT_NOSTR_RELAYS);

/**
 * Check if a user can view a repository
 * Returns the repo owner pubkey and whether access is allowed
 */
export async function checkRepoAccess(
  npub: string,
  repo: string,
  userPubkey: string | null
): Promise<{ allowed: boolean; repoOwnerPubkey: string; error?: string }> {
  try {
    // Decode npub to get pubkey
    let repoOwnerPubkey: string;
    try {
      const decoded = nip19.decode(npub);
      if (decoded.type === 'npub') {
        repoOwnerPubkey = decoded.data as string;
      } else {
        return { allowed: false, repoOwnerPubkey: '', error: 'Invalid npub format' };
      }
    } catch {
      return { allowed: false, repoOwnerPubkey: '', error: 'Invalid npub format' };
    }

    // Check if user can view
    const canView = await maintainerService.canView(userPubkey, repoOwnerPubkey, repo);
    
    return {
      allowed: canView,
      repoOwnerPubkey,
      ...(canView ? {} : { error: 'This repository is private. Only owners and maintainers can view it.' })
    };
  } catch (error) {
    return {
      allowed: false,
      repoOwnerPubkey: '',
      error: error instanceof Error ? error.message : 'Failed to check repository access'
    };
  }
}
