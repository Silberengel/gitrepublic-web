<script lang="ts">
  import CommentRenderer, { type Comment } from './CommentRenderer.svelte';
  import UserBadge from './UserBadge.svelte';
  import EventCopyButton from './EventCopyButton.svelte';
  import type { NostrEvent } from '$lib/types/nostr.js';

  export interface Discussion {
    id: string;
    title: string;
    content?: string;
    author: string;
    createdAt: number;
    kind: number;
    pubkey: string;
    type: 'thread' | 'comments';
    comments?: Comment[];
  }

  interface Props {
    discussion: Discussion;
    discussionEvent?: NostrEvent;
    eventCache: Map<string, NostrEvent>;
    profileCache: Map<string, string>;
    userPubkey?: string | null;
    onReplyToThread?: (threadId: string) => void;
    onReplyToComment?: (commentId: string) => void;
  }

  let {
    discussion,
    discussionEvent,
    eventCache,
    profileCache,
    userPubkey,
    onReplyToThread,
    onReplyToComment
  }: Props = $props();

  function countAllReplies(comments?: Comment[]): number {
    if (!comments) return 0;
    let count = comments.length;
    for (const comment of comments) {
      if (comment.replies) {
        count += countAllReplies(comment.replies);
      }
    }
    return count;
  }

  const hasComments = $derived(discussion.comments && discussion.comments.length > 0);
  const totalReplies = $derived(hasComments ? countAllReplies(discussion.comments) : 0);
</script>

<div class="discussion-item">
  <div class="discussion-header">
    <h3 class="discussion-title">{discussion.title}</h3>
    <div class="discussion-meta">
      {#if discussion.type === 'thread'}
        <span class="discussion-type">Thread</span>
        {#if hasComments}
          <span class="comment-count">{totalReplies} {totalReplies === 1 ? 'reply' : 'replies'}</span>
        {/if}
      {:else}
        <span class="discussion-type">Comments</span>
      {/if}
      <span>Created {new Date(discussion.createdAt * 1000).toLocaleString()}</span>
      <EventCopyButton eventId={discussion.id} kind={discussion.kind} pubkey={discussion.pubkey} />
      {#if discussion.type === 'thread' && userPubkey && onReplyToThread}
        <button 
          class="create-reply-button"
          onclick={() => onReplyToThread(discussion.id)}
          title="Reply to thread"
        >
          <img src="/icons/plus.svg" alt="Reply" class="icon" />
        </button>
      {/if}
    </div>
  </div>
  {#if discussion.content}
    <div class="discussion-body">
      <p>{discussion.content}</p>
    </div>
  {/if}
  {#if discussion.type === 'thread' && hasComments}
    <div class="comments-section">
      <h4>Replies ({totalReplies})</h4>
      {#each discussion.comments! as comment}
        <CommentRenderer
          comment={comment}
          commentEvent={eventCache.get(comment.id)}
          {eventCache}
          {profileCache}
          {userPubkey}
          onReply={onReplyToComment}
        />
      {/each}
    </div>
  {:else if discussion.type === 'comments' && hasComments}
    <div class="comments-section">
      <h4>Comments ({totalReplies})</h4>
      {#each discussion.comments! as comment}
        <CommentRenderer
          comment={comment}
          commentEvent={eventCache.get(comment.id)}
          {eventCache}
          {profileCache}
          {userPubkey}
          onReply={onReplyToComment}
        />
      {/each}
    </div>
  {/if}
</div>

<style>
  .discussion-item {
    padding: 1rem;
    margin-bottom: 1.5rem;
    border: 1px solid var(--border-color, #e0e0e0);
    border-radius: 8px;
    background: var(--discussion-bg, #fff);
  }

  .discussion-header {
    margin-bottom: 1rem;
  }

  .discussion-title {
    margin: 0 0 0.5rem 0;
    font-size: 1.25rem;
    font-weight: 600;
  }

  .discussion-meta {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    font-size: 0.875rem;
    color: var(--text-secondary, #666);
  }

  .discussion-type {
    padding: 0.25rem 0.5rem;
    background: var(--type-bg, #e0e0e0);
    border-radius: 4px;
    font-weight: 500;
  }

  .comment-count {
    font-weight: 500;
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

  .discussion-body {
    margin-bottom: 1rem;
    padding: 0.75rem;
    background: var(--body-bg, #f9f9f9);
    border-radius: 4px;
  }

  .discussion-body p {
    margin: 0;
  }

  .comments-section {
    margin-top: 1rem;
    padding-top: 1rem;
    border-top: 1px solid var(--border-color, #e0e0e0);
  }

  .comments-section h4 {
    margin: 0 0 1rem 0;
    font-size: 1rem;
    font-weight: 600;
  }
</style>
