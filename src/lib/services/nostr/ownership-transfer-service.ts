/**
 * Service for handling repository ownership transfers
 * Allows current owners to transfer ownership to another pubkey via Nostr events
 */

import { NostrClient } from './nostr-client.js';
import { KIND } from '../../types/nostr.js';
import type { NostrEvent } from '../../types/nostr.js';
import { verifyEvent } from 'nostr-tools';
import { nip19 } from 'nostr-tools';
import logger from '../logger.js';

export interface OwnershipTransfer {
  event: NostrEvent;
  fromPubkey: string;
  toPubkey: string;
  repoId: string;
  timestamp: number;
}

/**
 * Service for managing repository ownership transfers
 */
export class OwnershipTransferService {
  private nostrClient: NostrClient;
  private cache: Map<string, { owner: string; timestamp: number }> = new Map();
  private cacheTTL = 5 * 60 * 1000; // 5 minutes

  constructor(relays: string[]) {
    this.nostrClient = new NostrClient(relays);
  }

  /**
   * Get the current owner of a repository, checking for ownership transfers
   * The initial ownership is proven by a self-transfer event (from owner to themselves)
   * 
   * @param originalOwnerPubkey - The original owner from the repo announcement
   * @param repoId - The repository identifier (d-tag)
   * @returns The current owner pubkey (may be different from original if transferred)
   */
  async getCurrentOwner(originalOwnerPubkey: string, repoId: string): Promise<string> {
    const cacheKey = `${originalOwnerPubkey}:${repoId}`;
    const cached = this.cache.get(cacheKey);
    
    // Return cached if still valid
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      return cached.owner;
    }

    try {
      // Fetch all ownership transfer events for this repo
      // We use the 'a' tag to reference the repo announcement
      const repoTag = `${KIND.REPO_ANNOUNCEMENT}:${originalOwnerPubkey}:${repoId}`;
      
      const transferEvents = await this.nostrClient.fetchEvents([
        {
          kinds: [KIND.OWNERSHIP_TRANSFER],
          '#a': [repoTag],
          limit: 100 // Get all transfers to find the most recent valid one
        }
      ]);

      if (transferEvents.length === 0) {
        // No transfer events found - check if there's a self-transfer from the original owner
        // This would be the initial ownership proof
        // For now, if no transfers exist, we fall back to original owner
        // In the future, we might require a self-transfer event for initial ownership
        const result = originalOwnerPubkey;
        this.cache.set(cacheKey, { owner: result, timestamp: Date.now() });
        return result;
      }

      // Sort by created_at ascending to process in chronological order
      transferEvents.sort((a, b) => a.created_at - b.created_at);

      // Start with original owner, then apply transfers in chronological order
      let currentOwner = originalOwnerPubkey;
      const validTransfers: OwnershipTransfer[] = [];
      
      // Collect all valid transfers (including self-transfers for initial ownership proof)
      for (const event of transferEvents) {
        const transfer = this.parseTransferEvent(event, originalOwnerPubkey, repoId);
        if (transfer && this.isValidTransfer(transfer, originalOwnerPubkey, validTransfers)) {
          validTransfers.push(transfer);
        }
      }

      // Apply transfers in chronological order
      for (const transfer of validTransfers) {
        // Verify the transfer is from the current owner
        // Self-transfers (from == to) don't change ownership but establish initial proof
        if (transfer.fromPubkey === currentOwner) {
          // Only change owner if it's not a self-transfer
          if (transfer.fromPubkey !== transfer.toPubkey) {
            currentOwner = transfer.toPubkey;
          }
          // Self-transfers are valid but don't change ownership
        }
      }

      this.cache.set(cacheKey, { owner: currentOwner, timestamp: Date.now() });
      return currentOwner;
    } catch (error) {
      logger.error({ error, originalOwnerPubkey, repoName }, 'Error fetching ownership transfers');
      // Fallback to original owner
      return originalOwnerPubkey;
    }
  }

  /**
   * Parse an ownership transfer event
   */
  private parseTransferEvent(
    event: NostrEvent,
    originalOwnerPubkey: string,
    repoId: string
  ): OwnershipTransfer | null {
    // Verify event signature
    if (!verifyEvent(event)) {
      return null;
    }

    // Check that it's an ownership transfer event
    if (event.kind !== KIND.OWNERSHIP_TRANSFER) {
      return null;
    }

    // Extract 'a' tag (repo reference)
    const aTag = event.tags.find(t => t[0] === 'a');
    if (!aTag || !aTag[1]) {
      return null;
    }

    // Verify 'a' tag matches this repo
    const expectedRepoTag = `${KIND.REPO_ANNOUNCEMENT}:${originalOwnerPubkey}:${repoId}`;
    if (aTag[1] !== expectedRepoTag) {
      return null;
    }

    // Extract 'p' tag (new owner)
    const pTag = event.tags.find(t => t[0] === 'p');
    if (!pTag || !pTag[1]) {
      return null;
    }

    // Decode npub if needed
    let toPubkey = pTag[1];
    try {
      const decoded = nip19.decode(toPubkey);
      if (decoded.type === 'npub') {
        toPubkey = decoded.data as string;
      }
    } catch {
      // Assume it's already a hex pubkey
    }

    return {
      event,
      fromPubkey: event.pubkey, // Transfer is signed by current owner
      toPubkey,
      repoId,
      timestamp: event.created_at
    };
  }

  /**
   * Validate that a transfer is valid
   * A transfer is valid if:
   * 1. It's signed by the current owner (at the time of transfer)
   * 2. The event is properly formatted
   * 3. Self-transfers (from owner to themselves) are valid for initial ownership proof
   * 
   * @param transfer - The transfer to validate
   * @param originalOwnerPubkey - The original owner from repo announcement
   * @param previousTransfers - Previously validated transfers (for chain verification)
   */
  private isValidTransfer(
    transfer: OwnershipTransfer,
    originalOwnerPubkey: string,
    previousTransfers: OwnershipTransfer[] = []
  ): boolean {
    // Self-transfers are valid (from owner to themselves) - used for initial ownership proof
    if (transfer.fromPubkey === transfer.toPubkey) {
      // Self-transfer must be from the original owner (initial ownership proof)
      // or from a current owner (re-asserting ownership)
      return transfer.fromPubkey === originalOwnerPubkey || 
             previousTransfers.some(t => t.toPubkey === transfer.fromPubkey);
    }

    // Regular transfers must be from a valid owner
    // Check if the fromPubkey is the original owner or a previous transfer recipient
    const isValidFrom = transfer.fromPubkey === originalOwnerPubkey ||
                       previousTransfers.some(t => t.toPubkey === transfer.fromPubkey);
    
    // Also check basic format
    const validFormat = transfer.fromPubkey.length === 64 && 
                      transfer.toPubkey.length === 64;

    return isValidFrom && validFormat;
  }

  /**
   * Create an ownership transfer event template
   * 
   * @param fromPubkey - Current owner's pubkey
   * @param toPubkey - New owner's pubkey (hex or npub). If same as fromPubkey, creates a self-transfer (initial ownership proof)
   * @param originalOwnerPubkey - Original owner from repo announcement
   * @param repoId - Repository identifier (d-tag)
   * @returns Event template ready to be signed
   */
  createTransferEvent(
    fromPubkey: string,
    toPubkey: string,
    originalOwnerPubkey: string,
    repoId: string
  ): Omit<NostrEvent, 'sig' | 'id'> {
    // Decode npub if needed
    let toPubkeyHex = toPubkey;
    try {
      const decoded = nip19.decode(toPubkey);
      if (decoded.type === 'npub') {
        toPubkeyHex = decoded.data as string;
      }
    } catch {
      // Assume it's already a hex pubkey
    }

    const repoTag = `${KIND.REPO_ANNOUNCEMENT}:${originalOwnerPubkey}:${repoId}`;
    const isSelfTransfer = fromPubkey === toPubkeyHex;
    const content = isSelfTransfer
      ? `Initial ownership proof for repository ${repoId}`
      : `Transferring ownership of repository ${repoId} to ${toPubkeyHex}`;

    return {
      kind: KIND.OWNERSHIP_TRANSFER,
      pubkey: fromPubkey,
      created_at: Math.floor(Date.now() / 1000),
      content: content,
      tags: [
        ['a', repoTag], // Reference to repo announcement
        ['p', toPubkeyHex], // New owner (or same owner for self-transfer)
        ['d', repoId], // Repository identifier
        ...(isSelfTransfer ? [['t', 'self-transfer']] : []), // Tag to indicate self-transfer
      ]
    };
  }

  /**
   * Create an initial ownership proof event (self-transfer)
   * This should be created when a repository is first announced
   * 
   * @param ownerPubkey - Owner's pubkey
   * @param repoId - Repository identifier (d-tag)
   * @returns Event template ready to be signed
   */
  createInitialOwnershipEvent(
    ownerPubkey: string,
    repoId: string
  ): Omit<NostrEvent, 'sig' | 'id'> {
    return this.createTransferEvent(ownerPubkey, ownerPubkey, ownerPubkey, repoId);
  }

  /**
   * Verify that a user can initiate a transfer (must be current owner)
   */
  async canTransfer(userPubkey: string, originalOwnerPubkey: string, repoId: string): Promise<boolean> {
    const currentOwner = await this.getCurrentOwner(originalOwnerPubkey, repoId);
    return currentOwner === userPubkey;
  }

  /**
   * Clear cache for a repository (useful after ownership changes)
   */
  clearCache(originalOwnerPubkey: string, repoId: string): void {
    const cacheKey = `${originalOwnerPubkey}:${repoId}`;
    this.cache.delete(cacheKey);
  }

  /**
   * Get all valid ownership transfers for a repository (for history/display)
   */
  async getTransferHistory(originalOwnerPubkey: string, repoId: string): Promise<OwnershipTransfer[]> {
    try {
      const repoTag = `${KIND.REPO_ANNOUNCEMENT}:${originalOwnerPubkey}:${repoId}`;
      
      const transferEvents = await this.nostrClient.fetchEvents([
        {
          kinds: [KIND.OWNERSHIP_TRANSFER],
          '#a': [repoTag],
          limit: 100
        }
      ]);

      const transfers: OwnershipTransfer[] = [];
      // Sort by timestamp to validate in order
      const sortedEvents = [...transferEvents].sort((a, b) => a.created_at - b.created_at);
      
      for (const event of sortedEvents) {
        const transfer = this.parseTransferEvent(event, originalOwnerPubkey, repoId);
        if (transfer && this.isValidTransfer(transfer, originalOwnerPubkey, transfers)) {
          transfers.push(transfer);
        }
      }

      // Sort by timestamp descending (most recent first)
      transfers.sort((a, b) => b.timestamp - a.timestamp);
      return transfers;
    } catch (error) {
      logger.error({ error, ownerPubkey, repoName }, 'Error fetching transfer history');
      return [];
    }
  }
}
