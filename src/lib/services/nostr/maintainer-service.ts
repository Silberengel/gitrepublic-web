/**
 * Service for checking repository maintainer permissions
 * Based on NIP-34 repository announcements
 */

import { NostrClient } from './nostr-client.js';
import { KIND } from '../../types/nostr.js';
import type { NostrEvent } from '../../types/nostr.js';
import { nip19 } from 'nostr-tools';
import { OwnershipTransferService } from './ownership-transfer-service.js';

export interface RepoPrivacyInfo {
  isPrivate: boolean;
  owner: string;
  maintainers: string[];
}

export class MaintainerService {
  private nostrClient: NostrClient;
  private ownershipTransferService: OwnershipTransferService;
  private cache: Map<string, { maintainers: string[]; owner: string; timestamp: number; isPrivate: boolean }> = new Map();
  private cacheTTL = 5 * 60 * 1000; // 5 minutes

  constructor(relays: string[]) {
    this.nostrClient = new NostrClient(relays);
    this.ownershipTransferService = new OwnershipTransferService(relays);
  }

  /**
   * Check if a repository is private
   * A repo is private if it has a tag ["private", "true"] or ["t", "private"]
   */
  private isPrivateRepo(announcement: NostrEvent): boolean {
    // Check for ["private", "true"] tag
    const privateTag = announcement.tags.find(t => t[0] === 'private' && t[1] === 'true');
    if (privateTag) return true;

    // Check for ["t", "private"] tag (topic tag)
    const topicTag = announcement.tags.find(t => t[0] === 't' && t[1] === 'private');
    if (topicTag) return true;

    return false;
  }

  /**
   * Get maintainers and privacy info for a repository from NIP-34 announcement
   */
  async getMaintainers(repoOwnerPubkey: string, repoId: string): Promise<{ owner: string; maintainers: string[]; isPrivate: boolean }> {
    const cacheKey = `${repoOwnerPubkey}:${repoId}`;
    const cached = this.cache.get(cacheKey);
    
    // Return cached if still valid
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      return { owner: cached.owner, maintainers: cached.maintainers, isPrivate: cached.isPrivate };
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
        // If no announcement found, only the owner is a maintainer, and repo is public by default
        const result = { owner: repoOwnerPubkey, maintainers: [repoOwnerPubkey], isPrivate: false };
        this.cache.set(cacheKey, { ...result, timestamp: Date.now() });
        return result;
      }

      const announcement = events[0];
      
      // Check if repo is private
      const isPrivate = this.isPrivateRepo(announcement);
      
      // Check for ownership transfers - get current owner
      const currentOwner = await this.ownershipTransferService.getCurrentOwner(
        announcement.pubkey,
        repoId
      );
      
      const maintainers: string[] = [currentOwner]; // Current owner is always a maintainer

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

      const result = { owner: currentOwner, maintainers, isPrivate };
      this.cache.set(cacheKey, { ...result, timestamp: Date.now() });
      return result;
    } catch (error) {
      console.error('Error fetching maintainers:', error);
      // Fallback: only owner is maintainer, repo is public by default
      const result = { owner: repoOwnerPubkey, maintainers: [repoOwnerPubkey], isPrivate: false };
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
   * Check if a user can view a repository
   * Public repos: anyone can view
   * Private repos: only owners and maintainers can view
   */
  async canView(userPubkey: string | null, repoOwnerPubkey: string, repoId: string): Promise<boolean> {
    const { isPrivate, maintainers } = await this.getMaintainers(repoOwnerPubkey, repoId);
    
    // Public repos are viewable by anyone
    if (!isPrivate) {
      return true;
    }

    // Private repos require authentication
    if (!userPubkey) {
      return false;
    }

    // Convert userPubkey to hex if needed
    let userPubkeyHex = userPubkey;
    try {
      const decoded = nip19.decode(userPubkey);
      if (decoded.type === 'npub') {
        userPubkeyHex = decoded.data as string;
      }
    } catch {
      // Assume it's already a hex pubkey
    }

    // Check if user is owner or maintainer
    return maintainers.includes(userPubkeyHex);
  }

  /**
   * Get privacy info for a repository
   */
  async getPrivacyInfo(repoOwnerPubkey: string, repoId: string): Promise<RepoPrivacyInfo> {
    const { owner, maintainers, isPrivate } = await this.getMaintainers(repoOwnerPubkey, repoId);
    return { isPrivate, owner, maintainers };
  }

  /**
   * Clear cache for a repository (useful after maintainer changes)
   */
  clearCache(repoOwnerPubkey: string, repoId: string): void {
    const cacheKey = `${repoOwnerPubkey}:${repoId}`;
    this.cache.delete(cacheKey);
  }
}
