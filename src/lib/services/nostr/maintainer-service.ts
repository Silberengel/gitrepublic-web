/**
 * Service for checking repository maintainer permissions
 * Based on NIP-34 repository announcements
 */

import { NostrClient } from './nostr-client.js';
import { KIND } from '../../types/nostr.js';
import type { NostrEvent } from '../../types/nostr.js';
import { nip19 } from 'nostr-tools';
import { OwnershipTransferService } from './ownership-transfer-service.js';
import logger from '../logger.js';

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
      
      // Get current owner from the most recent announcement file in the repo
      // Ownership is determined by what's checked into the git repository, not Nostr events
      const { nip19 } = await import('nostr-tools');
      const npub = nip19.npubEncode(announcement.pubkey);
      const { fileManager } = await import('../../services/service-registry.js');
      const currentOwner = await fileManager.getCurrentOwnerFromRepo(npub, repoId) || announcement.pubkey;
      
      const maintainers: string[] = [currentOwner]; // Current owner is always a maintainer

      // Extract maintainers from tags
      // Maintainers tag format: ['maintainers', 'pubkey1', 'pubkey2', 'pubkey3', ...]
      for (const tag of announcement.tags) {
        if (tag[0] === 'maintainers') {
          // Iterate through all maintainers in the tag (skip index 0 which is 'maintainers')
          for (let i = 1; i < tag.length; i++) {
            const maintainerValue = tag[i];
            if (!maintainerValue || typeof maintainerValue !== 'string') {
              continue;
            }
            
            // Maintainers can be npub or hex pubkey
            let pubkey = maintainerValue;
            try {
              // Try to decode if it's an npub
              const decoded = nip19.decode(pubkey);
              if (decoded.type === 'npub') {
                pubkey = decoded.data as string;
              }
            } catch {
              // Assume it's already a hex pubkey
            }
            
            // Add maintainer if it's valid and not already in the list (case-insensitive check)
            if (pubkey && !maintainers.some(m => m.toLowerCase() === pubkey.toLowerCase())) {
              maintainers.push(pubkey);
            }
          }
        }
      }

      const result = { owner: currentOwner, maintainers, isPrivate };
      this.cache.set(cacheKey, { ...result, timestamp: Date.now() });
      return result;
    } catch (error) {
      logger.error({ error, repoOwnerPubkey, repoId }, 'Error fetching maintainers');
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
    const { isPrivate, maintainers, owner } = await this.getMaintainers(repoOwnerPubkey, repoId);
    
    logger.debug({ 
      isPrivate, 
      repoOwnerPubkey: repoOwnerPubkey.substring(0, 16) + '...', 
      currentOwner: owner.substring(0, 16) + '...',
      repoId,
      userPubkey: userPubkey ? userPubkey.substring(0, 16) + '...' : null,
      maintainerCount: maintainers.length
    }, 'canView check');
    
    // Public repos are viewable by anyone
    if (!isPrivate) {
      logger.debug({ repoOwnerPubkey: repoOwnerPubkey.substring(0, 16) + '...', repoId }, 'Access granted: repo is public');
      return true;
    }

    // Private repos require authentication
    if (!userPubkey) {
      logger.debug({ repoOwnerPubkey: repoOwnerPubkey.substring(0, 16) + '...', repoId }, 'Access denied: no user pubkey provided for private repo');
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
    
    // Normalize to lowercase for comparison
    userPubkeyHex = userPubkeyHex.toLowerCase();
    const normalizedMaintainers = maintainers.map(m => m.toLowerCase());
    const normalizedOwner = owner.toLowerCase();

    logger.debug({ 
      userPubkeyHex: userPubkeyHex.substring(0, 16) + '...', 
      normalizedOwner: normalizedOwner.substring(0, 16) + '...',
      maintainers: normalizedMaintainers.map(m => m.substring(0, 16) + '...')
    }, 'Comparing pubkeys');

    // Check if user is in maintainers list OR is the current owner
    const hasAccess = normalizedMaintainers.includes(userPubkeyHex) || userPubkeyHex === normalizedOwner;
    
    if (!hasAccess) {
      logger.debug({ 
        userPubkeyHex: userPubkeyHex.substring(0, 16) + '...', 
        currentOwner: normalizedOwner.substring(0, 16) + '...', 
        repoId,
        maintainers: normalizedMaintainers.map(m => m.substring(0, 16) + '...')
      }, 'Access denied: user not in maintainers list and not current owner');
    } else {
      logger.debug({ 
        userPubkeyHex: userPubkeyHex.substring(0, 16) + '...', 
        currentOwner: normalizedOwner.substring(0, 16) + '...', 
        repoId
      }, 'Access granted: user is maintainer or current owner');
    }

    // Check if user is owner or maintainer
    return hasAccess;
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
