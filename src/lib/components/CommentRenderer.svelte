<script lang="ts">
  import UserBadge from '$lib/components/UserBadge.svelte';
  import EventCopyButton from '$lib/components/EventCopyButton.svelte';
  import {
    processContentWithNostrLinks,
    getReferencedEventFromDiscussion,
    formatDiscussionTime,
    type ProcessedContentPart
  } from '$lib/utils/nostr-links.js';
  import type { NostrEvent } from '$lib/types/nostr.js';
  import CommentRendererSelf from './CommentRenderer.svelte';

  export interface Comment {
    id: string;
    content: string;
    author: string;
    createdAt: number;
    kind: number;
    pubkey: string;
    replies?: Comment[];
  }

  interface Props {
    comment: Comment;
    commentEvent?: NostrEvent; // Full event for getting referenced events
    eventCache: Map<string, NostrEvent>;
    profileCache: Map<string, string>;
    userPubkey?: string | null;
    onReply?: (commentId: string) => void;
    nested?: boolean;
  }

  let {
    comment,
    commentEvent,
    eventCache,
    profileCache,
    userPubkey,
    onReply,
    nested = false
  }: Props = $props();

  const referencedEvent = $derived(commentEvent
    ? getReferencedEventFromDiscussion(commentEvent, eventCache)
    : undefined);

  const contentParts = $derived(processContentWithNostrLinks(comment.content, eventCache, profileCache));
</script>

<div class="comment-item" class:nested-comment={nested}>
  <div class="comment-meta">
    <UserBadge pubkey={comment.author} />
    <span>{new Date(comment.createdAt * 1000).toLocaleString()}</span>
    <EventCopyButton eventId={comment.id} kind={comment.kind} pubkey={comment.pubkey} />
    {#if userPubkey && onReply}
      <button 
        class="create-reply-button"
        onclick={() => onReply(comment.id)}
        title="Reply to comment"
      >
        <img src="/icons/plus.svg" alt="Reply" class="icon" />
      </button>
    {/if}
  </div>
  <div class="comment-content">
    {#if referencedEvent}
      <div class="referenced-event">
        <div class="referenced-event-header">
          <UserBadge pubkey={referencedEvent.pubkey} disableLink={true} />
          <span class="referenced-event-time">{formatDiscussionTime(referencedEvent.created_at)}</span>
        </div>
        <div class="referenced-event-content">{referencedEvent.content || '(No content)'}</div>
      </div>
    {/if}
    <div>
      {#each contentParts as part}
        {#if part.type === 'text'}
          <span>{part.value}</span>
        {:else if part.type === 'event' && part.event}
          <div class="nostr-link-event">
            <div class="nostr-link-event-header">
              <UserBadge pubkey={part.event.pubkey} disableLink={true} />
              <span class="nostr-link-event-time">{formatDiscussionTime(part.event.created_at)}</span>
            </div>
            <div class="nostr-link-event-content">{part.event.content || '(No content)'}</div>
          </div>
        {:else if part.type === 'profile' && part.pubkey}
          <UserBadge pubkey={part.pubkey} />
        {:else}
          <span class="nostr-link-placeholder">{part.value}</span>
        {/if}
      {/each}
    </div>
  </div>
  {#if comment.replies && comment.replies.length > 0}
    <div class="nested-replies">
      {#each comment.replies as reply}
        <CommentRendererSelf
          comment={reply}
          commentEvent={eventCache.get(reply.id)}
          {eventCache}
          {profileCache}
          {userPubkey}
          {onReply}
          nested={true}
        />
      {/each}
    </div>
  {/if}
</div>

<style>
  .comment-item {
    margin-bottom: 1rem;
    padding: 0.75rem;
    border-left: 2px solid var(--border-color, #e0e0e0);
    background: var(--comment-bg, #f9f9f9);
  }

  .nested-comment {
    margin-left: 1.5rem;
    margin-top: 0.5rem;
    border-left-color: var(--nested-border-color, #ccc);
    background: var(--nested-comment-bg, #f5f5f5);
  }

  .comment-meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
    font-size: 0.875rem;
    color: var(--text-secondary, #666);
  }

  .comment-content {
    margin-top: 0.5rem;
  }

  .create-reply-button {
    margin-left: auto;
    background: none;
    border: none;
    cursor: pointer;
    padding: 0.25rem;
    display: flex;
    align-items: center;
  }

  .create-reply-button:hover {
    opacity: 0.7;
  }

  .create-reply-button .icon {
    width: 16px;
    height: 16px;
  }

  .nested-replies {
    margin-top: 0.75rem;
    padding-left: 0.5rem;
  }

  .referenced-event {
    margin-bottom: 0.75rem;
    padding: 0.5rem;
    background: var(--referenced-bg, #f0f0f0);
    border-radius: 4px;
    border-left: 2px solid var(--referenced-border, #999);
  }

  .referenced-event-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.25rem;
    font-size: 0.875rem;
  }

  .referenced-event-time {
    color: var(--text-secondary, #666);
  }

  .referenced-event-content {
    font-size: 0.9rem;
    color: var(--text-secondary, #666);
  }

  .nostr-link-event {
    margin: 0.5rem 0;
    padding: 0.5rem;
    background: var(--link-event-bg, #f0f0f0);
    border-radius: 4px;
    border-left: 2px solid var(--link-event-border, #999);
  }

  .nostr-link-event-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.25rem;
    font-size: 0.875rem;
  }

  .nostr-link-event-time {
    color: var(--text-secondary, #666);
  }

  .nostr-link-event-content {
    font-size: 0.9rem;
    color: var(--text-secondary, #666);
  }

  .nostr-link-placeholder {
    color: var(--link-color, #0066cc);
    text-decoration: underline;
  }
</style>
