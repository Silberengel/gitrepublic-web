<script module lang="ts">
  export interface Comment {
    id: string;
    content: string;
    author: string;
    createdAt: number;
    kind: number;
    pubkey: string;
    replies?: Comment[];
  }
</script>

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
          <span class="referenced-event-label">Replying to:</span>
          <UserBadge pubkey={referencedEvent.pubkey} disableLink={true} inline={true} />
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
    border-left: 2px solid var(--border-color);
    background: var(--bg-tertiary, var(--bg-secondary));
    color: var(--text-primary);
  }

  .nested-comment {
    margin-left: 1.5rem;
    margin-top: 0.5rem;
    border-left-color: var(--border-color);
    background: var(--bg-secondary, var(--bg-primary));
  }

  .comment-meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
    font-size: 0.875rem;
    color: var(--text-secondary);
  }

  .comment-content {
    margin-top: 0.5rem;
    color: var(--text-primary);
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
    background: var(--bg-secondary, var(--bg-primary));
    color: var(--text-muted, var(--text-secondary));
    border-radius: 4px;
    border-left: 2px solid var(--border-light, var(--border-color));
    opacity: 0.8;
  }

  .referenced-event-header {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    margin-bottom: 0.25rem;
    font-size: 0.75rem;
    color: var(--text-muted, var(--text-secondary));
  }

  .referenced-event-label {
    font-weight: 500;
    color: var(--text-muted, var(--text-secondary));
  }

  .referenced-event-time {
    color: var(--text-muted, var(--text-secondary));
    font-size: 0.7rem;
  }

  .referenced-event-content {
    font-size: 0.8rem;
    color: var(--text-muted, var(--text-secondary));
    line-height: 1.4;
  }

  .nostr-link-event {
    margin: 0.5rem 0;
    padding: 0.5rem;
    background: var(--bg-secondary, var(--bg-primary));
    color: var(--text-primary);
    border-radius: 4px;
    border-left: 2px solid var(--border-color);
  }

  .nostr-link-event-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.25rem;
    font-size: 0.875rem;
  }

  .nostr-link-event-time {
    color: var(--text-secondary);
  }

  .nostr-link-event-content {
    font-size: 0.9rem;
    color: var(--text-primary);
  }

  .nostr-link-placeholder {
    color: var(--accent-color, var(--button-primary));
    text-decoration: underline;
  }
</style>
