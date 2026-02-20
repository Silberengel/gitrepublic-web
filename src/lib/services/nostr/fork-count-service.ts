/**
 * Service for counting forks of a repository
 */

import { NostrClient } from './nostr-client.js';
import { KIND } from '../../types/nostr.js';
import type { NostrEvent } from '../../types/nostr.js';
import logger from '../logger.js';

export class ForkCountService {
  private nostrClient: NostrClient;
  private cache: Map<string, { count: number; timestamp: number }> = new Map();
  private cacheTTL = 5 * 60 * 1000; // 5 minutes

  constructor(relays: string[]) {
    this.nostrClient = new NostrClient(relays);
  }

  /**
   * Count forks of a repository
   * Forks are identified by having an 'a' tag pointing to the original repo
   * Format: ['a', '{KIND.REPO_ANNOUNCEMENT}:{originalOwnerPubkey}:{originalRepoName}']
   */
  async getForkCount(originalOwnerPubkey: string, originalRepoName: string): Promise<number> {
    const cacheKey = `${originalOwnerPubkey}:${originalRepoName}`;
    const cached = this.cache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      return cached.count;
    }

    try {
      // Find all repo announcements that reference this repo as a fork
      const repoTag = `${KIND.REPO_ANNOUNCEMENT}:${originalOwnerPubkey}:${originalRepoName}`;
      
      // Fetch all repo announcements and filter for forks manually
      // (NostrFilter doesn't support '#fork' tag, so we fetch all and filter)
      const allRepoEvents = await this.nostrClient.fetchEvents([
        {
          kinds: [KIND.REPO_ANNOUNCEMENT],
          limit: 1000
        }
      ]);

      // Filter for actual forks (have 'fork' tag or legacy 'a' tag matching the original repo)
      const forks = allRepoEvents.filter(event => {
        // Check for new standardized fork tag format: ['fork', '30617:pubkey:d-tag']
        const forkTag = event.tags.find(t => t[0] === 'fork' && t[1] === repoTag);
        if (forkTag) return true;
        // Legacy support: check for 'a' tag
        const aTag = event.tags.find(t => t[0] === 'a' && t[1] === repoTag);
        return aTag !== undefined;
      });

      const count = forks.length;
      
      // Cache the result
      this.cache.set(cacheKey, { count, timestamp: Date.now() });
      
      return count;
    } catch (error) {
      logger.error({ error, originalOwnerPubkey, originalRepoName }, '[ForkCount] Error counting forks');
      // Return cached value if available, otherwise 0
      return cached?.count || 0;
    }
  }

  /**
   * Invalidate cache for a repository (call after fork is created)
   */
  invalidateCache(originalOwnerPubkey: string, originalRepoName: string): void {
    const cacheKey = `${originalOwnerPubkey}:${originalRepoName}`;
    this.cache.delete(cacheKey);
  }
}
