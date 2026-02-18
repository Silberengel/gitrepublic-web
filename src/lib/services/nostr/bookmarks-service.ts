/**
 * Service for managing user bookmarks (kind 10003)
 * NIP-51: Lists - Bookmarks
 */

import { NostrClient } from './nostr-client.js';
import type { NostrEvent } from '../../types/nostr.js';
import { KIND } from '../../types/nostr.js';
import { getPublicKeyWithNIP07, signEventWithNIP07 } from './nip07-signer.js';
import logger from '../logger.js';
import { truncatePubkey } from '../../utils/security.js';

export class BookmarksService {
  private nostrClient: NostrClient;

  constructor(relays: string[]) {
    this.nostrClient = new NostrClient(relays);
  }

  /**
   * Fetch user's bookmarks (kind 10003)
   * Returns the most recent bookmark list event
   */
  async getBookmarks(pubkey: string): Promise<NostrEvent | null> {
    try {
      const events = await this.nostrClient.fetchEvents([
        {
          kinds: [KIND.BOOKMARKS],
          authors: [pubkey],
          limit: 1
        }
      ]);

      if (events.length === 0) {
        return null;
      }

      // Sort by created_at descending and return the newest
      events.sort((a, b) => b.created_at - a.created_at);
      return events[0];
    } catch (error) {
      logger.error({ error, pubkey: truncatePubkey(pubkey) }, 'Failed to fetch bookmarks');
      return null;
    }
  }

  /**
   * Get all bookmarked repo addresses (a-tags) from user's bookmarks
   */
  async getBookmarkedRepos(pubkey: string): Promise<Set<string>> {
    const bookmarks = await this.getBookmarks(pubkey);
    if (!bookmarks) {
      return new Set();
    }

    const repoAddresses = new Set<string>();
    for (const tag of bookmarks.tags) {
      if (tag[0] === 'a' && tag[1]) {
        // Check if it's a repo announcement address (kind 30617)
        const address = tag[1];
        if (address.startsWith(`${KIND.REPO_ANNOUNCEMENT}:`)) {
          repoAddresses.add(address);
        }
      }
    }

    return repoAddresses;
  }

  /**
   * Check if a repo is bookmarked
   */
  async isBookmarked(pubkey: string, repoAddress: string): Promise<boolean> {
    const bookmarkedRepos = await this.getBookmarkedRepos(pubkey);
    return bookmarkedRepos.has(repoAddress);
  }

  /**
   * Add a repo to bookmarks
   * Creates or updates the bookmark list event
   */
  async addBookmark(pubkey: string, repoAddress: string, relays: string[]): Promise<boolean> {
    try {
      // Get existing bookmarks
      const existingBookmarks = await this.getBookmarks(pubkey);
      
      // Extract existing a-tags (for repos)
      const existingATags: string[] = [];
      if (existingBookmarks) {
        for (const tag of existingBookmarks.tags) {
          if (tag[0] === 'a' && tag[1]) {
            // Only include repo announcement addresses
            if (tag[1].startsWith(`${KIND.REPO_ANNOUNCEMENT}:`)) {
              existingATags.push(tag[1]);
            }
          }
        }
      }

      // Check if already bookmarked
      if (existingATags.includes(repoAddress)) {
        logger.debug({ pubkey: truncatePubkey(pubkey), repoAddress }, 'Repo already bookmarked');
        return true;
      }

      // Add new bookmark to the end (chronological order per NIP-51)
      existingATags.push(repoAddress);

      // Create new bookmark event
      const tags: string[][] = existingATags.map(addr => ['a', addr]);

      const eventTemplate: Omit<NostrEvent, 'id' | 'sig'> = {
        kind: KIND.BOOKMARKS,
        pubkey,
        created_at: Math.floor(Date.now() / 1000),
        content: '', // Public bookmarks use tags, not encrypted content
        tags
      };

      // Sign with NIP-07
      const signedEvent = await signEventWithNIP07(eventTemplate);

      // Publish to relays
      const result = await this.nostrClient.publishEvent(signedEvent, relays);
      
      if (result.success.length > 0) {
        logger.debug({ pubkey: truncatePubkey(pubkey), repoAddress }, 'Bookmark added successfully');
        return true;
      } else {
        logger.error({ pubkey: truncatePubkey(pubkey), repoAddress, errors: result.failed }, 'Failed to publish bookmark');
        return false;
      }
    } catch (error) {
      logger.error({ error, pubkey: truncatePubkey(pubkey), repoAddress }, 'Failed to add bookmark');
      return false;
    }
  }

  /**
   * Remove a repo from bookmarks
   * Creates a new bookmark list event without the specified repo
   */
  async removeBookmark(pubkey: string, repoAddress: string, relays: string[]): Promise<boolean> {
    try {
      // Get existing bookmarks
      const existingBookmarks = await this.getBookmarks(pubkey);
      
      if (!existingBookmarks) {
        logger.debug({ pubkey: truncatePubkey(pubkey), repoAddress }, 'No bookmarks to remove from');
        return true;
      }

      // Extract existing a-tags (for repos), excluding the one to remove
      const existingATags: string[] = [];
      for (const tag of existingBookmarks.tags) {
        if (tag[0] === 'a' && tag[1]) {
          // Only include repo announcement addresses, and exclude the one to remove
          if (tag[1].startsWith(`${KIND.REPO_ANNOUNCEMENT}:`) && tag[1] !== repoAddress) {
            existingATags.push(tag[1]);
          }
        }
      }

      // Check if it was bookmarked
      if (existingATags.length === existingBookmarks.tags.filter(t => t[0] === 'a' && t[1]?.startsWith(`${KIND.REPO_ANNOUNCEMENT}:`)).length) {
        logger.debug({ pubkey: truncatePubkey(pubkey), repoAddress }, 'Repo was not bookmarked');
        return true;
      }

      // Create new bookmark event without the removed bookmark
      const tags: string[][] = existingATags.map(addr => ['a', addr]);

      const eventTemplate: Omit<NostrEvent, 'id' | 'sig'> = {
        kind: KIND.BOOKMARKS,
        pubkey,
        created_at: Math.floor(Date.now() / 1000),
        content: '', // Public bookmarks use tags, not encrypted content
        tags
      };

      // Sign with NIP-07
      const signedEvent = await signEventWithNIP07(eventTemplate);

      // Publish to relays
      const result = await this.nostrClient.publishEvent(signedEvent, relays);
      
      if (result.success.length > 0) {
        logger.debug({ pubkey: truncatePubkey(pubkey), repoAddress }, 'Bookmark removed successfully');
        return true;
      } else {
        logger.error({ pubkey: truncatePubkey(pubkey), repoAddress, errors: result.failed }, 'Failed to publish bookmark removal');
        return false;
      }
    } catch (error) {
      logger.error({ error, pubkey: truncatePubkey(pubkey), repoAddress }, 'Failed to remove bookmark');
      return false;
    }
  }
}
