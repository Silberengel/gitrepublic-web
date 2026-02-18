/**
 * Service for managing repository discussions (NIP-7D kind 11 threads and NIP-22 kind 1111 comments)
 */

import { NostrClient } from './nostr-client.js';
import { KIND } from '../../types/nostr.js';
import type { NostrEvent } from '../../types/nostr.js';
import { verifyEvent } from 'nostr-tools';

export interface Thread extends NostrEvent {
  kind: typeof KIND.THREAD;
  title?: string;
}

export interface Comment extends NostrEvent {
  kind: typeof KIND.COMMENT;
  rootKind: number;
  parentKind: number;
  rootPubkey?: string;
  parentPubkey?: string;
}

export interface DiscussionThread extends Thread {
  comments?: Comment[];
}

export interface DiscussionEntry {
  type: 'thread' | 'comments';
  id: string;
  title: string;
  content: string;
  author: string;
  createdAt: number;
  comments?: Comment[];
}

/**
 * Service for managing discussions
 */
export class DiscussionsService {
  private nostrClient: NostrClient;

  constructor(relays: string[] = []) {
    this.nostrClient = new NostrClient(relays);
  }

  /**
   * Get repo address from owner and repo ID
   */
  private getRepoAddress(repoOwnerPubkey: string, repoId: string): string {
    return `${KIND.REPO_ANNOUNCEMENT}:${repoOwnerPubkey}:${repoId}`;
  }

  /**
   * Fetch kind 11 discussion threads from chat relays
   * Threads should reference the repo announcement via an 'a' tag
   */
  async getThreads(
    repoOwnerPubkey: string,
    repoId: string,
    chatRelays: string[]
  ): Promise<Thread[]> {
    if (!chatRelays || chatRelays.length === 0) {
      return [];
    }

    const repoAddress = this.getRepoAddress(repoOwnerPubkey, repoId);
    
    // Create a client for chat relays
    const chatClient = new NostrClient(chatRelays);
    
    // Fetch threads from chat relays
    const threads = await chatClient.fetchEvents([
      {
        kinds: [KIND.THREAD],
        '#a': [repoAddress],
        limit: 100
      }
    ]) as NostrEvent[];

    const parsedThreads: Thread[] = [];
    for (const event of threads) {
      if (!verifyEvent(event)) {
        continue;
      }

      if (event.kind !== KIND.THREAD) {
        continue;
      }

      const titleTag = event.tags.find(t => t[0] === 'title');
      
      parsedThreads.push({
        ...event,
        kind: KIND.THREAD,
        title: titleTag?.[1]
      });
    }

    // Sort by creation time (newest first)
    parsedThreads.sort((a, b) => b.created_at - a.created_at);
    return parsedThreads;
  }

  /**
   * Fetch kind 1111 comments directly on the repo announcement event
   * Comments should reference the repo announcement via 'E' and 'K' tags
   */
  async getCommentsOnAnnouncement(
    announcementId: string,
    announcementPubkey: string,
    relays: string[]
  ): Promise<Comment[]> {
    // Create a client for the specified relays
    const relayClient = new NostrClient(relays);
    
    const comments = await relayClient.fetchEvents([
      {
        kinds: [KIND.COMMENT],
        '#E': [announcementId], // Uppercase E for root event (NIP-22)
        '#K': [KIND.REPO_ANNOUNCEMENT.toString()], // Uppercase K for root kind (NIP-22)
        limit: 100
      }
    ]) as NostrEvent[];

    const parsedComments: Comment[] = [];
    for (const event of comments) {
      if (!verifyEvent(event)) {
        continue;
      }

      // Verify this comment is for the repo announcement
      // NIP-22 uses uppercase 'E' for root event ID
      const ETag = event.tags.find(t => t[0] === 'E');
      const KTag = event.tags.find(t => t[0] === 'K');
      const PTag = event.tags.find(t => t[0] === 'P');
      
      if (!ETag || ETag[1] !== announcementId) {
        continue;
      }

      if (!KTag || KTag[1] !== KIND.REPO_ANNOUNCEMENT.toString()) {
        continue;
      }

      // For top-level comments, parent should also be the announcement
      // NIP-22 uses lowercase 'e' for parent event ID
      const eTag = event.tags.find(t => t[0] === 'e');
      const kTag = event.tags.find(t => t[0] === 'k');
      const pTag = event.tags.find(t => t[0] === 'p');

      // Only include comments that are direct replies to the announcement
      // (parent is the announcement, not another comment)
      if (eTag && eTag[1] === announcementId && kTag && kTag[1] === KIND.REPO_ANNOUNCEMENT.toString()) {
        parsedComments.push({
          ...event,
          kind: KIND.COMMENT,
          rootKind: KTag ? parseInt(KTag[1]) : 0,
          parentKind: kTag ? parseInt(kTag[1]) : 0,
          rootPubkey: PTag?.[1] || announcementPubkey,
          parentPubkey: pTag?.[1] || announcementPubkey
        });
      }
    }

    // Sort by creation time (oldest first for comments)
    parsedComments.sort((a, b) => a.created_at - b.created_at);
    return parsedComments;
  }

  /**
   * Get all discussions (threads + comments) for a repository
   */
  async getDiscussions(
    repoOwnerPubkey: string,
    repoId: string,
    announcementId: string,
    announcementPubkey: string,
    chatRelays: string[],
    defaultRelays: string[]
  ): Promise<DiscussionEntry[]> {
    const entries: DiscussionEntry[] = [];

    // Fetch threads from chat relays
    const threads = await this.getThreads(repoOwnerPubkey, repoId, chatRelays);
    
    for (const thread of threads) {
      entries.push({
        type: 'thread',
        id: thread.id,
        title: thread.title || 'Untitled Thread',
        content: thread.content,
        author: thread.pubkey,
        createdAt: thread.created_at
      });
    }

    // Fetch comments directly on the announcement
    const comments = await this.getCommentsOnAnnouncement(
      announcementId,
      announcementPubkey,
      defaultRelays
    );

    // If there are comments, create a pseudo-thread entry called "Comments"
    if (comments.length > 0) {
      entries.push({
        type: 'comments',
        id: `comments-${announcementId}`,
        title: 'Comments',
        content: '', // No content for the pseudo-thread
        author: '',
        createdAt: comments[0]?.created_at || 0,
        comments
      });
    }

    // Sort entries: threads first (by creation time, newest first), then comments
    entries.sort((a, b) => {
      if (a.type === 'comments' && b.type === 'thread') {
        return 1; // Comments always go last
      }
      if (a.type === 'thread' && b.type === 'comments') {
        return -1; // Threads always go first
      }
      // Both same type, sort by creation time
      return b.createdAt - a.createdAt;
    });

    return entries;
  }
}
