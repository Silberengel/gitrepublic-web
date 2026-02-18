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
   * Creates or updates the bookmark list event, preserving all existing tags
   * Per NIP-51: new items are appended to the end, and duplicates are removed
   */
  async addBookmark(pubkey: string, repoAddress: string, relays: string[]): Promise<boolean> {
    try {
      // Get existing bookmarks
      const existingBookmarks = await this.getBookmarks(pubkey);
      
      // Preserve ALL existing tags (not just a-tags)
      const existingTags: string[][] = [];
      const seenAddresses = new Set<string>();
      
      if (existingBookmarks) {
        for (const tag of existingBookmarks.tags) {
          // For 'a' tags, deduplicate repo addresses
          if (tag[0] === 'a' && tag[1]) {
            if (tag[1].startsWith(`${KIND.REPO_ANNOUNCEMENT}:`)) {
              // Skip if we've already seen this address (deduplication)
              if (seenAddresses.has(tag[1])) {
                continue;
              }
              seenAddresses.add(tag[1]);
            }
          }
          // Preserve all other tags as-is
          existingTags.push([...tag]);
        }
      }

      // Check if already bookmarked
      if (seenAddresses.has(repoAddress)) {
        logger.debug({ pubkey: truncatePubkey(pubkey), repoAddress }, 'Repo already bookmarked');
        return true;
      }

      // Add new bookmark to the end (chronological order per NIP-51)
      existingTags.push(['a', repoAddress]);

      const eventTemplate: Omit<NostrEvent, 'id' | 'sig'> = {
        kind: KIND.BOOKMARKS,
        pubkey,
        created_at: Math.floor(Date.now() / 1000),
        content: '', // Public bookmarks use tags, not encrypted content
        tags: existingTags
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
   * Creates a new bookmark list event without the specified repo, preserving all other tags
   */
  async removeBookmark(pubkey: string, repoAddress: string, relays: string[]): Promise<boolean> {
    try {
      // Get existing bookmarks
      const existingBookmarks = await this.getBookmarks(pubkey);
      
      if (!existingBookmarks) {
        logger.debug({ pubkey: truncatePubkey(pubkey), repoAddress }, 'No bookmarks to remove from');
        return true;
      }

      // Preserve ALL existing tags except the one to remove
      const existingTags: string[][] = [];
      let found = false;
      
      for (const tag of existingBookmarks.tags) {
        // Skip the tag that matches the repo address to remove
        if (tag[0] === 'a' && tag[1] === repoAddress) {
          found = true;
          continue; // Skip this tag
        }
        // Preserve all other tags
        existingTags.push([...tag]);
      }

      // Check if it was bookmarked
      if (!found) {
        logger.debug({ pubkey: truncatePubkey(pubkey), repoAddress }, 'Repo was not bookmarked');
        return true;
      }

      const eventTemplate: Omit<NostrEvent, 'id' | 'sig'> = {
        kind: KIND.BOOKMARKS,
        pubkey,
        created_at: Math.floor(Date.now() / 1000),
        content: '', // Public bookmarks use tags, not encrypted content
        tags: existingTags
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
