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
  comments?: Array<{
    id: string;
    content: string;
    author: string;
    createdAt: number;
    replies?: Array<{
      id: string;
      content: string;
      author: string;
      createdAt: number;
      replies?: Array<{
        id: string;
        content: string;
        author: string;
        createdAt: number;
      }>;
    }>;
  }>;
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
    allRelays: string[]
  ): Promise<Thread[]> {
    // If no relays provided, return empty
    if (!allRelays || allRelays.length === 0) {
      console.warn('[Discussions] No relays provided to getThreads');
      return [];
    }

    const repoAddress = this.getRepoAddress(repoOwnerPubkey, repoId);
    console.log('[Discussions] Fetching threads for repo address:', repoAddress, 'from relays:', allRelays);
    
    // Create a client for all available relays
    const client = new NostrClient(allRelays);
    
    // Fetch threads from all available relays
    const threads = await client.fetchEvents([
      {
        kinds: [KIND.THREAD],
        '#a': [repoAddress],
        limit: 100
      }
    ]) as NostrEvent[];
    
    console.log('[Discussions] Found', threads.length, 'thread events');

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
   * Comments can reference the repo announcement via:
   * 1. 'a' tag with repo address (e.g., "30617:pubkey:repo")
   * 2. 'E' and 'K' tags (NIP-22 standard)
   */
  async getCommentsOnAnnouncement(
    announcementId: string,
    announcementPubkey: string,
    relays: string[],
    repoOwnerPubkey?: string,
    repoId?: string
  ): Promise<Comment[]> {
    // Create a client for the specified relays
    const relayClient = new NostrClient(relays);
    
    // Build repo address for a-tag matching
    const repoAddress = repoOwnerPubkey && repoId 
      ? this.getRepoAddress(repoOwnerPubkey, repoId)
      : null;
    
    // Fetch comments using both methods:
    // 1. Comments with a-tag (repo address)
    // 2. Comments with E/K tags (NIP-22)
    // Fetch ALL comments with announcement as root (including nested replies)
    const filters: any[] = [];
    
    if (repoAddress) {
      // Filter for comments with a-tag matching repo address
      filters.push({
        kinds: [KIND.COMMENT],
        '#a': [repoAddress],
        limit: 500 // Increased limit to get nested replies
      });
    }
    
    // Also fetch comments using NIP-22 tags - fetch ALL with announcement as root
    filters.push({
      kinds: [KIND.COMMENT],
      '#E': [announcementId], // Uppercase E for root event (NIP-22)
      '#K': [KIND.REPO_ANNOUNCEMENT.toString()], // Uppercase K for root kind (NIP-22)
      limit: 500 // Increased limit to get nested replies
    });
    
    const allComments = await relayClient.fetchEvents(filters) as NostrEvent[];
    
    // Deduplicate by event ID
    const seenIds = new Set<string>();
    const parsedComments: Comment[] = [];
    
    for (const event of allComments) {
      // Skip duplicates
      if (seenIds.has(event.id)) {
        continue;
      }
      seenIds.add(event.id);
      
      if (!verifyEvent(event)) {
        continue;
      }

      // Check if comment references repo via a-tag
      const aTag = event.tags.find(t => t[0] === 'a');
      const hasATag = aTag && repoAddress && aTag[1] === repoAddress;
      
      // Check if comment references repo via NIP-22 tags
      const ETag = event.tags.find(t => t[0] === 'E');
      const KTag = event.tags.find(t => t[0] === 'K');
      const PTag = event.tags.find(t => t[0] === 'P');
      const hasNIP22Tags = ETag && ETag[1] === announcementId && 
                           KTag && KTag[1] === KIND.REPO_ANNOUNCEMENT.toString();
      
      // Include comment if it matches either method
      // For NIP-22, include ALL comments with announcement as root (including nested replies)
      if (hasATag || hasNIP22Tags) {
        // For a-tag comments, only include top-level (parent is announcement)
        if (hasATag && !hasNIP22Tags) {
          const eTag = event.tags.find(t => t[0] === 'e');
          // If it has an 'e' tag that's not the announcement, it's a nested reply
          // We'll include it if it has the repo address in 'a' tag
          // (The buildCommentTree will handle nesting)
        }
        
        parsedComments.push({
          ...event,
          kind: KIND.COMMENT,
          rootKind: KTag ? parseInt(KTag[1]) : KIND.REPO_ANNOUNCEMENT,
          parentKind: event.tags.find(t => t[0] === 'k') 
            ? parseInt(event.tags.find(t => t[0] === 'k')![1]) 
            : KIND.REPO_ANNOUNCEMENT,
          rootPubkey: PTag?.[1] || announcementPubkey,
          parentPubkey: event.tags.find(t => t[0] === 'p')?.[1] || announcementPubkey
        });
      }
    }

    // Sort by creation time (oldest first for comments)
    parsedComments.sort((a, b) => a.created_at - b.created_at);
    return parsedComments;
  }

  /**
   * Fetch kind 1111 comments for a specific thread (kind 11 event)
   * Fetches ALL comments that have this thread as root (including nested replies)
   */
  async getThreadComments(
    threadId: string,
    threadPubkey: string,
    relays: string[]
  ): Promise<Comment[]> {
    const relayClient = new NostrClient(relays);
    
    // Fetch ALL comments that have this thread as root (via E tag)
    // This includes both direct replies and nested replies
    const comments = await relayClient.fetchEvents([
      {
        kinds: [KIND.COMMENT],
        '#E': [threadId], // Root event (the thread)
        '#K': [KIND.THREAD.toString()], // Root kind (11)
        limit: 500 // Increased limit to get all nested replies
      }
    ]) as NostrEvent[];

    const parsedComments: Comment[] = [];
    const seenIds = new Set<string>();
    
    for (const event of comments) {
      if (seenIds.has(event.id)) continue;
      seenIds.add(event.id);
      
      if (!verifyEvent(event)) {
        continue;
      }

      // Check if comment has this thread as root
      const ETag = event.tags.find(t => t[0] === 'E');
      const KTag = event.tags.find(t => t[0] === 'K');
      const eTag = event.tags.find(t => t[0] === 'e');
      const kTag = event.tags.find(t => t[0] === 'k');
      const pTag = event.tags.find(t => t[0] === 'p');
      const PTag = event.tags.find(t => t[0] === 'P');
      
      // Comment must have this thread as root
      if (ETag && ETag[1] === threadId && KTag && KTag[1] === KIND.THREAD.toString()) {
        parsedComments.push({
          ...event,
          kind: KIND.COMMENT,
          rootKind: parseInt(KTag[1]),
          parentKind: kTag ? parseInt(kTag[1]) : KIND.THREAD,
          rootPubkey: PTag?.[1] || threadPubkey,
          parentPubkey: pTag?.[1] || threadPubkey
        });
      }
    }

    // Sort by creation time (oldest first for comments)
    parsedComments.sort((a, b) => a.created_at - b.created_at);
    return parsedComments;
  }

  /**
   * Build nested comment structure from flat list
   */
  private buildCommentTree(comments: Comment[]): Array<{
    id: string;
    content: string;
    author: string;
    createdAt: number;
    replies?: Array<{
      id: string;
      content: string;
      author: string;
      createdAt: number;
      replies?: Array<{
        id: string;
        content: string;
        author: string;
        createdAt: number;
      }>;
    }>;
  }> {
    if (comments.length === 0) return [];

    // Create a map of comment ID to comment data
    const commentMap = new Map<string, {
      id: string;
      content: string;
      author: string;
      createdAt: number;
      parentId?: string;
      replies: any[];
    }>();

    // First pass: create all comment nodes
    for (const comment of comments) {
      const eTag = comment.tags.find(t => t[0] === 'e');
      // Parent is the 'e' tag value (the comment/thread this replies to)
      const parentId = eTag ? eTag[1] : undefined;
      
      commentMap.set(comment.id, {
        id: comment.id,
        content: comment.content,
        author: comment.pubkey,
        createdAt: comment.created_at,
        parentId,
        replies: []
      });
    }

    // Second pass: build tree structure
    const rootComments: any[] = [];
    for (const [id, comment] of commentMap) {
      if (comment.parentId && commentMap.has(comment.parentId)) {
        // This is a reply to another comment, add it to parent's replies
        const parent = commentMap.get(comment.parentId)!;
        parent.replies.push(comment);
      } else {
        // This is a top-level comment (replies directly to thread/announcement)
        rootComments.push(comment);
      }
    }

    // Recursively convert to the expected format
    const formatComment = (comment: any): any => {
      return {
        id: comment.id,
        content: comment.content,
        author: comment.author,
        createdAt: comment.createdAt,
        replies: comment.replies.length > 0 ? comment.replies.map(formatComment) : undefined
      };
    };

    return rootComments.map(formatComment);
  }

  /**
   * Get all discussions (threads + comments) for a repository
   */
  async getDiscussions(
    repoOwnerPubkey: string,
    repoId: string,
    announcementId: string,
    announcementPubkey: string,
    allRelays: string[],
    commentRelays: string[]
  ): Promise<DiscussionEntry[]> {
    const entries: DiscussionEntry[] = [];

    // Fetch threads from all available relays
    const threads = await this.getThreads(repoOwnerPubkey, repoId, allRelays);
    
    // Fetch comments for each thread
    for (const thread of threads) {
      const threadComments = await this.getThreadComments(thread.id, thread.pubkey, allRelays);
      
      // Build nested comment tree
      const commentTree = threadComments.length > 0 ? this.buildCommentTree(threadComments) : undefined;
      
      entries.push({
        type: 'thread',
        id: thread.id,
        title: thread.title || 'Untitled Thread',
        content: thread.content,
        author: thread.pubkey,
        createdAt: thread.created_at,
        comments: commentTree
      });
    }

    // Fetch comments directly on the announcement
    const comments = await this.getCommentsOnAnnouncement(
      announcementId,
      announcementPubkey,
      commentRelays,
      repoOwnerPubkey,
      repoId
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
        comments: comments.map(c => ({
          id: c.id,
          content: c.content,
          author: c.pubkey,
          createdAt: c.created_at
        }))
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
