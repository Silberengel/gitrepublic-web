/**
 * Discussion utilities
 * Handles discussion event processing and formatting
 */

import type { NostrEvent } from '$lib/types/nostr.js';
import { KIND } from '$lib/types/nostr.js';
import { getReferencedEventFromDiscussion as getReferencedEventFromDiscussionUtil } from '$lib/utils/nostr-links.js';

/**
 * Format discussion timestamp
 */
export function formatDiscussionTime(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins} minute${diffMins > 1 ? 's' : ''} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
  if (diffDays < 7) return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
  
  return date.toLocaleDateString();
}

/**
 * Get discussion event by ID
 */
export function getDiscussionEvent(eventId: string, events: Map<string, NostrEvent>): NostrEvent | undefined {
  return events.get(eventId);
}

/**
 * Get referenced event from discussion (checks e-tag, a-tag, and q-tag)
 * Re-exports the shared utility function for convenience
 */
export function getReferencedEventFromDiscussion(
  event: NostrEvent,
  events: Map<string, NostrEvent>
): NostrEvent | undefined {
  return getReferencedEventFromDiscussionUtil(event, events);
}

/**
 * Count all replies recursively
 */
export function countAllReplies(comments: Array<{ replies?: Array<any> }> | undefined): number {
  if (!comments || comments.length === 0) {
    return 0;
  }
  let count = comments.length;
  for (const comment of comments) {
    if (comment.replies && comment.replies.length > 0) {
      count += countAllReplies(comment.replies);
    }
  }
  return count;
}

/**
 * Toggle thread expansion
 */
export function toggleThread(
  threadId: string,
  expandedThreads: Set<string>
): void {
  if (expandedThreads.has(threadId)) {
    expandedThreads.delete(threadId);
  } else {
    expandedThreads.add(threadId);
  }
}
