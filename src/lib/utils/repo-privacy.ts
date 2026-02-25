/**
 * Helper utilities for checking repository privacy
 */

import { nip19 } from 'nostr-tools';
import { DEFAULT_NOSTR_RELAYS } from '../config.js';
import type { NostrEvent } from '../types/nostr.js';
import { isPrivateRepo as checkVisibility } from './repo-visibility.js';

// Lazy initialization to avoid initialization order issues
let maintainerServiceInstance: import('../services/nostr/maintainer-service.js').MaintainerService | null = null;

const getMaintainerService = async (): Promise<import('../services/nostr/maintainer-service.js').MaintainerService> => {
  if (!maintainerServiceInstance) {
    const { MaintainerService } = await import('../services/nostr/maintainer-service.js');
    maintainerServiceInstance = new MaintainerService(DEFAULT_NOSTR_RELAYS);
  }
  return maintainerServiceInstance;
};

/**
 * Check if a repository is private based on announcement event
 * Uses the new visibility system: restricted or private visibility means private repo
 * 
 * This is a shared utility to avoid code duplication across services.
 */
export function isPrivateRepo(announcement: NostrEvent): boolean {
  // Use the new visibility system
  return checkVisibility(announcement);
}

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
    const maintainerService = await getMaintainerService();
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
