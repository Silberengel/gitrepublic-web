/**
 * Service for checking repository maintainer permissions
 * Based on NIP-34 repository announcements
 */

import { NostrClient } from './nostr-client.js';
import { KIND } from '../../types/nostr.js';
import type { NostrEvent } from '../../types/nostr.js';
import { nip19 } from 'nostr-tools';

export class MaintainerService {
  private nostrClient: NostrClient;
  private cache: Map<string, { maintainers: string[]; owner: string; timestamp: number }> = new Map();
  private cacheTTL = 5 * 60 * 1000; // 5 minutes

  constructor(relays: string[]) {
    this.nostrClient = new NostrClient(relays);
  }

  /**
   * Get maintainers for a repository from NIP-34 announcement
   */
  async getMaintainers(repoOwnerPubkey: string, repoId: string): Promise<{ owner: string; maintainers: string[] }> {
    const cacheKey = `${repoOwnerPubkey}:${repoId}`;
    const cached = this.cache.get(cacheKey);
    
    // Return cached if still valid
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      return { owner: cached.owner, maintainers: cached.maintainers };
    }

    try {
      // Fetch the repository announcement
      const events = await this.nostrClient.fetchEvents([
        {
          kinds: [KIND.REPO_ANNOUNCEMENT],
          authors: [repoOwnerPubkey],
          '#d': [repoId],
          limit: 1
        }
      ]);

      if (events.length === 0) {
        // If no announcement found, only the owner is a maintainer
        const result = { owner: repoOwnerPubkey, maintainers: [repoOwnerPubkey] };
        this.cache.set(cacheKey, { ...result, timestamp: Date.now() });
        return result;
      }

      const announcement = events[0];
      const maintainers: string[] = [announcement.pubkey]; // Owner is always a maintainer

      // Extract maintainers from tags
      for (const tag of announcement.tags) {
        if (tag[0] === 'maintainers' && tag[1]) {
          // Maintainers can be npub or hex pubkey
          let pubkey = tag[1];
          try {
            // Try to decode if it's an npub
            const decoded = nip19.decode(pubkey);
            if (decoded.type === 'npub') {
              pubkey = decoded.data as string;
            }
          } catch {
            // Assume it's already a hex pubkey
          }
          if (pubkey && !maintainers.includes(pubkey)) {
            maintainers.push(pubkey);
          }
        }
      }

      const result = { owner: announcement.pubkey, maintainers };
      this.cache.set(cacheKey, { ...result, timestamp: Date.now() });
      return result;
    } catch (error) {
      console.error('Error fetching maintainers:', error);
      // Fallback: only owner is maintainer
      const result = { owner: repoOwnerPubkey, maintainers: [repoOwnerPubkey] };
      this.cache.set(cacheKey, { ...result, timestamp: Date.now() });
      return result;
    }
  }

  /**
   * Check if a user is a maintainer of a repository
   */
  async isMaintainer(userPubkey: string, repoOwnerPubkey: string, repoId: string): Promise<boolean> {
    const { maintainers } = await this.getMaintainers(repoOwnerPubkey, repoId);
    return maintainers.includes(userPubkey);
  }

  /**
   * Clear cache for a repository (useful after maintainer changes)
   */
  clearCache(repoOwnerPubkey: string, repoId: string): void {
    const cacheKey = `${repoOwnerPubkey}:${repoId}`;
    this.cache.delete(cacheKey);
  }
}
