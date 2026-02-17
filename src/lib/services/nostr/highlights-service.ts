/**
 * Service for managing NIP-84 Highlights (kind 9802)
 * Used for code selections and comments in pull requests
 */

import { NostrClient } from './nostr-client.js';
import { KIND } from '../../types/nostr.js';
import type { NostrEvent } from '../../types/nostr.js';
import { verifyEvent } from 'nostr-tools';
import { nip19 } from 'nostr-tools';

export interface Highlight extends NostrEvent {
  kind: typeof KIND.HIGHLIGHT;
  highlightedContent: string;
  sourceUrl?: string;
  sourceEventId?: string;
  sourceEventAddress?: string;
  context?: string;
  authors?: Array<{ pubkey: string; role?: string }>;
  comment?: string; // If present, this is a quote highlight
  file?: string;
  lineStart?: number;
  lineEnd?: number;
}

export interface HighlightWithComments extends Highlight {
  comments: Comment[];
}

export interface Comment extends NostrEvent {
  kind: typeof KIND.COMMENT;
  rootKind: number;
  parentKind: number;
  rootPubkey?: string;
  parentPubkey?: string;
}

/**
 * Service for managing highlights and comments
 */
export class HighlightsService {
  private nostrClient: NostrClient;
  private relays: string[];

  constructor(relays: string[] = []) {
    this.relays = relays;
    this.nostrClient = new NostrClient(relays);
  }

  /**
   * Get repository announcement address (a tag format)
   */
  private getRepoAddress(repoOwnerPubkey: string, repoId: string): string {
    return `${KIND.REPO_ANNOUNCEMENT}:${repoOwnerPubkey}:${repoId}`;
  }

  /**
   * Get PR address (a tag format for PR)
   */
  private getPRAddress(prId: string, prAuthor: string, repoOwnerPubkey: string, repoId: string): string {
    return `${KIND.PULL_REQUEST}:${prAuthor}:${repoId}`;
  }

  /**
   * Fetch highlights for a pull request
   */
  async getHighlightsForPR(
    prId: string,
    prAuthor: string,
    repoOwnerPubkey: string,
    repoId: string
  ): Promise<HighlightWithComments[]> {
    const prAddress = this.getPRAddress(prId, prAuthor, repoOwnerPubkey, repoId);
    
    // Fetch highlights that reference this PR
    const highlights = await this.nostrClient.fetchEvents([
      {
        kinds: [KIND.HIGHLIGHT],
        '#a': [prAddress],
        limit: 100
      }
    ]) as Highlight[];

    // Also fetch highlights that reference the PR by event ID
    const highlightsByEvent = await this.nostrClient.fetchEvents([
      {
        kinds: [KIND.HIGHLIGHT],
        '#e': [prId],
        limit: 100
      }
    ]) as Highlight[];

    // Combine and deduplicate
    const allHighlights = [...highlights, ...highlightsByEvent];
    const uniqueHighlights = new Map<string, Highlight>();
    for (const highlight of allHighlights) {
      if (!uniqueHighlights.has(highlight.id) || highlight.created_at > uniqueHighlights.get(highlight.id)!.created_at) {
        uniqueHighlights.set(highlight.id, highlight);
      }
    }

    // Parse highlights
    const parsedHighlights: Highlight[] = [];
    for (const event of Array.from(uniqueHighlights.values())) {
      const highlight = this.parseHighlight(event);
      if (highlight) {
        parsedHighlights.push(highlight);
      }
    }

    // Fetch comments for each highlight
    const highlightsWithComments: HighlightWithComments[] = [];
    for (const highlight of parsedHighlights) {
      const comments = await this.getCommentsForHighlight(highlight.id);
      highlightsWithComments.push({
        ...highlight,
        comments
      });
    }

    // Sort by created_at descending (newest first)
    highlightsWithComments.sort((a, b) => b.created_at - a.created_at);

    return highlightsWithComments;
  }

  /**
   * Parse a highlight event
   */
  private parseHighlight(event: NostrEvent): Highlight | null {
    if (event.kind !== KIND.HIGHLIGHT) {
      return null;
    }

    if (!verifyEvent(event)) {
      return null;
    }

    // Extract source references
    const aTag = event.tags.find(t => t[0] === 'a');
    const eTag = event.tags.find(t => t[0] === 'e');
    const rTag = event.tags.find(t => t[0] === 'r' && !t[2]?.includes('mention'));
    const contextTag = event.tags.find(t => t[0] === 'context');
    const commentTag = event.tags.find(t => t[0] === 'comment');

    // Extract authors
    const authors: Array<{ pubkey: string; role?: string }> = [];
    for (const tag of event.tags) {
      if (tag[0] === 'p' && !tag[2]?.includes('mention')) {
        let pubkey = tag[1];
        try {
          const decoded = nip19.decode(pubkey);
          if (decoded.type === 'npub') {
            pubkey = decoded.data as string;
          }
        } catch {
          // Assume it's already hex
        }
        authors.push({
          pubkey,
          role: tag[3] // role is in 4th position
        });
      }
    }

    // Extract file path and line numbers
    const fileTag = event.tags.find(t => t[0] === 'file');
    const lineStartTag = event.tags.find(t => t[0] === 'line-start');
    const lineEndTag = event.tags.find(t => t[0] === 'line-end');

    return {
      ...event,
      kind: KIND.HIGHLIGHT,
      highlightedContent: event.content,
      sourceEventAddress: aTag?.[1],
      sourceEventId: eTag?.[1],
      sourceUrl: rTag?.[1],
      context: contextTag?.[1],
      authors: authors.length > 0 ? authors : undefined,
      comment: commentTag?.[1],
      file: fileTag?.[1],
      lineStart: lineStartTag ? parseInt(lineStartTag[1]) : undefined,
      lineEnd: lineEndTag ? parseInt(lineEndTag[1]) : undefined
    };
  }

  /**
   * Get comments for a highlight or PR
   */
  async getCommentsForHighlight(highlightId: string): Promise<Comment[]> {
    const comments = await this.nostrClient.fetchEvents([
      {
        kinds: [KIND.COMMENT],
        '#e': [highlightId],
        limit: 100
      }
    ]) as NostrEvent[];

    const parsedComments: Comment[] = [];
    for (const event of comments) {
      if (!verifyEvent(event)) {
        continue;
      }

      // Parse NIP-22 comment structure
      const kTag = event.tags.find(t => t[0] === 'k'); // Parent kind
      const KTag = event.tags.find(t => t[0] === 'K'); // Root kind
      const pTag = event.tags.find(t => t[0] === 'p'); // Parent author
      const PTag = event.tags.find(t => t[0] === 'P'); // Root author

      parsedComments.push({
        ...event,
        kind: KIND.COMMENT,
        rootKind: KTag ? parseInt(KTag[1]) : 0,
        parentKind: kTag ? parseInt(kTag[1]) : 0,
        rootPubkey: PTag?.[1],
        parentPubkey: pTag?.[1]
      });
    }

    // Sort by created_at ascending (oldest first)
    parsedComments.sort((a, b) => a.created_at - b.created_at);

    return parsedComments;
  }

  /**
   * Get comments for a pull request
   */
  async getCommentsForPR(prId: string): Promise<Comment[]> {
    const comments = await this.nostrClient.fetchEvents([
      {
        kinds: [KIND.COMMENT],
        '#e': [prId], // Root event (lowercase e for filter)
        limit: 100
      }
    ]) as NostrEvent[];

    const parsedComments: Comment[] = [];
    for (const event of comments) {
      if (!verifyEvent(event)) {
        continue;
      }

      const kTag = event.tags.find(t => t[0] === 'k');
      const KTag = event.tags.find(t => t[0] === 'K');
      const pTag = event.tags.find(t => t[0] === 'p');
      const PTag = event.tags.find(t => t[0] === 'P');

      parsedComments.push({
        ...event,
        kind: KIND.COMMENT,
        rootKind: KTag ? parseInt(KTag[1]) : 0,
        parentKind: kTag ? parseInt(kTag[1]) : 0,
        rootPubkey: PTag?.[1],
        parentPubkey: pTag?.[1]
      });
    }

    parsedComments.sort((a, b) => a.created_at - b.created_at);
    return parsedComments;
  }

  /**
   * Create a highlight event template
   * 
   * @param highlightedContent - The selected code/text content
   * @param prId - Pull request event ID
   * @param prAuthor - PR author pubkey
   * @param repoOwnerPubkey - Repository owner pubkey
   * @param repoId - Repository identifier
   * @param filePath - Path to the file being highlighted
   * @param lineStart - Starting line number (optional)
   * @param lineEnd - Ending line number (optional)
   * @param context - Surrounding context (optional)
   * @param comment - Comment text (optional, creates quote highlight)
   */
  createHighlightEvent(
    highlightedContent: string,
    prId: string,
    prAuthor: string,
    repoOwnerPubkey: string,
    repoId: string,
    filePath?: string,
    lineStart?: number,
    lineEnd?: number,
    context?: string,
    comment?: string
  ): Omit<NostrEvent, 'sig' | 'id'> {
    const prAddress = `${KIND.PULL_REQUEST}:${prAuthor}:${repoId}`;
    
    const tags: string[][] = [
      ['a', prAddress], // Reference to PR
      ['e', prId], // PR event ID
      ['P', prAuthor], // PR author
      ['K', KIND.PULL_REQUEST.toString()], // Root kind
    ];

    // Add file path and line numbers if provided
    if (filePath) {
      tags.push(['file', filePath]);
    }
    if (lineStart !== undefined) {
      tags.push(['line-start', lineStart.toString()]);
    }
    if (lineEnd !== undefined) {
      tags.push(['line-end', lineEnd.toString()]);
    }

    // Add context if provided
    if (context) {
      tags.push(['context', context]);
    }

    // Add comment if provided (creates quote highlight)
    if (comment) {
      tags.push(['comment', comment]);
    }

    return {
      kind: KIND.HIGHLIGHT,
      pubkey: '', // Will be filled by signer
      created_at: Math.floor(Date.now() / 1000),
      content: highlightedContent,
      tags
    };
  }

  /**
   * Create a comment event template (NIP-22)
   * 
   * @param content - Comment text
   * @param rootEventId - Root event ID (PR or highlight)
   * @param rootEventKind - Root event kind
   * @param rootPubkey - Root event author pubkey
   * @param parentEventId - Parent event ID (for replies)
   * @param parentEventKind - Parent event kind
   * @param parentPubkey - Parent event author pubkey
   * @param rootEventAddress - Root event address (optional, for replaceable events)
   */
  createCommentEvent(
    content: string,
    rootEventId: string,
    rootEventKind: number,
    rootPubkey: string,
    parentEventId?: string,
    parentEventKind?: number,
    parentPubkey?: string,
    rootEventAddress?: string,
    relayHint?: string
  ): Omit<NostrEvent, 'sig' | 'id'> {
    const relay = relayHint || '';
    const tags: string[][] = [
      ['E', rootEventId, relay, rootPubkey], // Root event (NIP-22: id, relay hint, pubkey)
      ['K', rootEventKind.toString()], // Root kind
      ['P', rootPubkey, relay], // Root author (with relay hint)
    ];

    // Add root event address if provided (for replaceable events)
    if (rootEventAddress) {
      tags.push(['A', rootEventAddress, relay]);
    }

    // Add parent references (for replies)
    if (parentEventId) {
      tags.push(['e', parentEventId, relay, parentPubkey || rootPubkey]);
      tags.push(['k', (parentEventKind || rootEventKind).toString()]);
      if (parentPubkey) {
        tags.push(['p', parentPubkey, relay]);
      }
    } else {
      // Top-level comment - parent is same as root
      tags.push(['e', rootEventId, relay, rootPubkey]);
      tags.push(['k', rootEventKind.toString()]);
      tags.push(['p', rootPubkey, relay]);
    }

    return {
      kind: KIND.COMMENT,
      pubkey: '', // Will be filled by signer
      created_at: Math.floor(Date.now() / 1000),
      content: content,
      tags
    };
  }
}
