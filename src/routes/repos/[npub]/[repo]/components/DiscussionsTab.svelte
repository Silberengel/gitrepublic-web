<script lang="ts">
  import { onMount } from 'svelte';
  import TabLayout from './TabLayout.svelte';
  import DiscussionRenderer, { type Discussion } from '$lib/components/DiscussionRenderer.svelte';
  import CommentRenderer from '$lib/components/CommentRenderer.svelte';
  
  // Define Comment type locally to match CommentRenderer's export
  type Comment = {
    id: string;
    content: string;
    author: string;
    createdAt: number;
    kind: number;
    pubkey: string;
    replies?: Comment[];
  };
  import EventCopyButton from '$lib/components/EventCopyButton.svelte';
  import { DiscussionsService } from '$lib/services/nostr/discussions-service.js';
  import { NostrClient } from '$lib/services/nostr/nostr-client.js';
  import { DEFAULT_NOSTR_RELAYS, DEFAULT_NOSTR_SEARCH_RELAYS, combineRelays } from '$lib/config.js';
  import { getUserRelays } from '$lib/services/nostr/user-relays.js';
  import { loadNostrLinks } from '$lib/utils/nostr-links.js';
  import type { NostrEvent } from '$lib/types/nostr.js';
  import { KIND } from '$lib/types/nostr.js';
  import { signEventWithNIP07, getPublicKeyWithNIP07 } from '$lib/services/nostr/nip07-signer.js';

  interface Props {
    npub: string;
    repo: string;
    repoAnnouncement?: NostrEvent;
    userPubkey?: string | null;
    activeTab?: string;
    tabs?: Array<{ id: string; label: string; icon?: string }>;
    onTabChange?: (tab: string) => void;
  }

  let { 
    npub, 
    repo, 
    repoAnnouncement, 
    userPubkey,
    activeTab = '',
    tabs = [],
    onTabChange = () => {}
  }: Props = $props();

  let discussions = $state<Discussion[]>([]);
  let loadingDiscussions = $state(false);
  let selectedDiscussion = $state<string | null>(null);
  let error = $state<string | null>(null);
  
  // Event caches for Nostr links
  let discussionEvents = $state<Map<string, NostrEvent>>(new Map());
  let nostrLinkEvents = $state<Map<string, NostrEvent>>(new Map());
  let nostrLinkProfiles = $state<Map<string, string>>(new Map());
  
  // Dialog states
  let showCreateThreadDialog = $state(false);
  let showReplyDialog = $state(false);
  let creatingThread = $state(false);
  let creatingReply = $state(false);
  let replyingToThread = $state<{ id: string; kind: number; pubkey: string; author: string } | null>(null);
  let replyingToComment = $state<{ id: string; kind: number; pubkey: string; author: string } | null>(null);
  let newThreadTitle = $state('');
  let newThreadContent = $state('');
  let replyContent = $state('');

  const discussionsService = new DiscussionsService(DEFAULT_NOSTR_RELAYS);
  const nostrClient = new NostrClient(DEFAULT_NOSTR_RELAYS);

  onMount(async () => {
    await loadDiscussions();
  });

  async function loadDiscussions() {
    if (!repoAnnouncement) return;
    
    loadingDiscussions = true;
    error = null;
    
    try {
      const userRelays = userPubkey ? await getUserRelays(userPubkey, nostrClient) : null;
      const allDefaultRelays = [...DEFAULT_NOSTR_RELAYS, ...DEFAULT_NOSTR_SEARCH_RELAYS];
      const combinedRelays = combineRelays(
        userRelays?.outbox || [],
        allDefaultRelays
      );
      
      const { nip19 } = await import('nostr-tools');
      const decoded = nip19.decode(npub);
      if (decoded.type !== 'npub') {
        throw new Error('Invalid npub format');
      }
      const repoOwnerPubkey = decoded.data as string;
      
      const discussionsServiceWithRelays = new DiscussionsService(combinedRelays);
      const discussionEntries = await discussionsServiceWithRelays.getDiscussions(
        repoOwnerPubkey,
        repo,
        repoAnnouncement.id,
        repoAnnouncement.pubkey,
        combinedRelays,
        combinedRelays
      );
      
      const fetchedDiscussions = discussionEntries.map(entry => ({
        type: entry.type,
        id: entry.id,
        title: entry.title,
        content: entry.content,
        author: entry.author,
        createdAt: entry.createdAt,
        kind: entry.kind ?? KIND.THREAD,
        pubkey: entry.pubkey ?? '',
        comments: entry.comments
      }));
      
      discussions = fetchedDiscussions;
      
      // Load events for discussions and comments
      await loadDiscussionEvents(fetchedDiscussions);
      
      // Load Nostr links from all discussion content
      for (const discussion of fetchedDiscussions) {
        if (discussion.content) {
          await loadNostrLinks(discussion.content, nostrClient, nostrLinkEvents, nostrLinkProfiles);
        }
        if (discussion.comments) {
          for (const comment of discussion.comments) {
            await loadNostrLinks(comment.content, nostrClient, nostrLinkEvents, nostrLinkProfiles);
            if (comment.replies) {
              for (const reply of comment.replies) {
                await loadNostrLinks(reply.content, nostrClient, nostrLinkEvents, nostrLinkProfiles);
              }
            }
          }
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load discussions';
      console.error('Error loading discussions:', err);
    } finally {
      loadingDiscussions = false;
    }
  }

  async function loadDiscussionEvents(discussionsList: Discussion[]) {
    const eventIds = new Set<string>();
    
    // Collect all event IDs
    for (const discussion of discussionsList) {
      if (discussion.id) {
        eventIds.add(discussion.id);
      }
      if (discussion.comments) {
        for (const comment of discussion.comments) {
          if (comment.id) {
            eventIds.add(comment.id);
          }
          if (comment.replies) {
            for (const reply of comment.replies) {
              if (reply.id) {
                eventIds.add(reply.id);
              }
            }
          }
        }
      }
    }
    
    if (eventIds.size === 0) return;
    
    try {
      const events = await Promise.race([
        nostrClient.fetchEvents([{ ids: Array.from(eventIds), limit: eventIds.size }]),
        new Promise<NostrEvent[]>((resolve) => setTimeout(() => resolve([]), 10000))
      ]);
      
      for (const event of events) {
        discussionEvents.set(event.id, event);
      }
    } catch {
      // Ignore fetch errors
    }
  }

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

  async function createDiscussionThread() {
    if (!userPubkey || !repoAnnouncement || !newThreadTitle.trim()) return;
    
    creatingThread = true;
    error = null;
    
    try {
      const userPubkeyHex = await getPublicKeyWithNIP07();
      if (!userPubkeyHex) throw new Error('Failed to get user pubkey');
      
      const { nip19 } = await import('nostr-tools');
      const decoded = nip19.decode(npub);
      if (decoded.type !== 'npub') {
        throw new Error('Invalid npub format');
      }
      const repoOwnerPubkey = decoded.data as string;
      const repoAddress = `${KIND.REPO_ANNOUNCEMENT}:${repoOwnerPubkey}:${repo}`;
      
      const threadEventTemplate: Omit<NostrEvent, 'sig' | 'id'> = {
        kind: KIND.THREAD,
        pubkey: userPubkeyHex,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['a', repoAddress],
          ['title', newThreadTitle.trim()],
          ['t', 'repo']
        ],
        content: newThreadContent.trim() || ''
      };
      
      const signedEvent = await signEventWithNIP07(threadEventTemplate);
      
      const userRelays = await getUserRelays(userPubkeyHex, nostrClient);
      const allDefaultRelays = [...DEFAULT_NOSTR_RELAYS, ...DEFAULT_NOSTR_SEARCH_RELAYS];
      const combinedRelays = combineRelays(
        userRelays?.outbox || [],
        allDefaultRelays
      );
      
      const publishClient = new NostrClient(combinedRelays);
      await publishClient.publishEvent(signedEvent, combinedRelays);
      
      showCreateThreadDialog = false;
      newThreadTitle = '';
      newThreadContent = '';
      await loadDiscussions();
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to create discussion thread';
      console.error('Error creating thread:', err);
    } finally {
      creatingThread = false;
    }
  }

  async function createThreadReply() {
    if (!userPubkey || !replyingToThread || !replyContent.trim()) return;
    
    creatingReply = true;
    error = null;
    
    try {
      const userPubkeyHex = await getPublicKeyWithNIP07();
      if (!userPubkeyHex) throw new Error('Failed to get user pubkey');
      
      const commentEventTemplate: Omit<NostrEvent, 'sig' | 'id'> = {
        kind: KIND.COMMENT,
        pubkey: userPubkeyHex,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['E', replyingToThread.id], // Root event (the thread)
          ['K', KIND.THREAD.toString()], // Root kind
          ['P', replyingToThread.pubkey], // Root pubkey
          ...(replyingToComment ? [
            ['e', replyingToComment.id], // Parent event (the comment being replied to)
            ['k', replyingToComment.kind.toString()], // Parent kind
            ['p', replyingToComment.pubkey] // Parent pubkey
          ] : [])
        ],
        content: replyContent.trim()
      };
      
      const signedEvent = await signEventWithNIP07(commentEventTemplate);
      
      const userRelays = await getUserRelays(userPubkeyHex, nostrClient);
      const allDefaultRelays = [...DEFAULT_NOSTR_RELAYS, ...DEFAULT_NOSTR_SEARCH_RELAYS];
      const combinedRelays = combineRelays(
        userRelays?.outbox || [],
        allDefaultRelays
      );
      
      const publishClient = new NostrClient(combinedRelays);
      await publishClient.publishEvent(signedEvent, combinedRelays);
      
      showReplyDialog = false;
      replyContent = '';
      replyingToThread = null;
      replyingToComment = null;
      await loadDiscussions();
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to create reply';
      console.error('Error creating reply:', err);
    } finally {
      creatingReply = false;
    }
  }

  function handleReplyToThread(threadId: string) {
    const discussion = discussions.find(d => d.id === threadId);
    if (discussion) {
      replyingToThread = { id: discussion.id, kind: discussion.kind, pubkey: discussion.pubkey, author: discussion.author };
      replyingToComment = null;
      showReplyDialog = true;
    }
  }

  function handleReplyToComment(commentId: string) {
    // Find the discussion and comment
    for (const discussion of discussions) {
      if (discussion.comments) {
        const findComment = (comments: Comment[]): Comment | undefined => {
          for (const comment of comments) {
            if (comment.id === commentId) return comment;
            if (comment.replies) {
              const found = findComment(comment.replies);
              if (found) return found;
            }
          }
          return undefined;
        };
        
        const comment = findComment(discussion.comments);
        if (comment) {
          replyingToThread = { id: discussion.id, kind: discussion.kind, pubkey: discussion.pubkey, author: discussion.author };
          replyingToComment = { id: comment.id, kind: comment.kind, pubkey: comment.pubkey, author: comment.author };
          showReplyDialog = true;
          return;
        }
      }
    }
  }
</script>

<TabLayout
  {activeTab}
  {tabs}
  {onTabChange}
  title="Discussions"
>
  {#snippet leftPane()}
    <div class="discussions-sidebar">
      <div class="discussions-header">
        <h2>Discussions</h2>
        {#if userPubkey}
          <button 
            onclick={() => showCreateThreadDialog = true}
            class="create-discussion-button"
            disabled={creatingThread}
            title={creatingThread ? 'Creating...' : 'New Discussion Thread'}
          >
            <img src="/icons/plus.svg" alt="New Discussion" class="icon" />
          </button>
        {/if}
      </div>
      {#if loadingDiscussions}
        <div class="loading">Loading discussions...</div>
      {:else if discussions.length > 0}
        <ul class="discussion-list">
          {#each discussions as discussion}
            {@const hasComments = discussion.comments && discussion.comments.length > 0}
            {@const totalReplies = hasComments ? countAllReplies(discussion.comments) : 0}
            <li class="discussion-item" class:selected={selectedDiscussion === discussion.id}>
              <button 
                onclick={() => selectedDiscussion = discussion.id}
                class="discussion-item-button"
              >
                <div class="discussion-header">
                  <span class="discussion-title">{discussion.title}</span>
                </div>
                <div class="discussion-meta">
                  {#if discussion.type === 'thread'}
                    <span class="discussion-type">Thread</span>
                    {#if hasComments}
                      <span class="comment-count">{totalReplies} {totalReplies === 1 ? 'reply' : 'replies'}</span>
                    {/if}
                  {:else}
                    <span class="discussion-type">Comments</span>
                  {/if}
                  <span>{new Date(discussion.createdAt * 1000).toLocaleDateString()}</span>
                  <EventCopyButton eventId={discussion.id} kind={discussion.kind} pubkey={discussion.pubkey} />
                </div>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/snippet}
  
  {#snippet rightPanel()}
    {#if error}
      <div class="error">{error}</div>
    {/if}
    {#if selectedDiscussion}
      {@const discussion = discussions.find(d => d.id === selectedDiscussion)}
      {#if discussion}
        <DiscussionRenderer
          {discussion}
          discussionEvent={discussionEvents.get(discussion.id)}
          eventCache={discussionEvents}
          profileCache={nostrLinkProfiles}
          {userPubkey}
          onReplyToThread={handleReplyToThread}
          onReplyToComment={handleReplyToComment}
        />
      {/if}
    {:else}
      <div class="empty-state">
        <p>Select a discussion from the sidebar to view it</p>
      </div>
    {/if}
  {/snippet}
</TabLayout>

<!-- Create Thread Dialog -->
{#if showCreateThreadDialog && userPubkey}
  <div 
    class="modal-overlay" 
    role="dialog"
    aria-modal="true"
    aria-label="Create discussion thread"
    onclick={() => showCreateThreadDialog = false}
    onkeydown={(e) => e.key === 'Escape' && (showCreateThreadDialog = false)}
    tabindex="-1"
  >
    <div 
      class="modal" 
      role="dialog"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
      tabindex="-1"
    >
      <h3>Create Discussion Thread</h3>
      <label>
        Title:
        <input type="text" bind:value={newThreadTitle} placeholder="Thread title..." />
      </label>
      <label>
        Content:
        <textarea bind:value={newThreadContent} rows="6" placeholder="Thread content..."></textarea>
      </label>
      <div class="modal-actions">
        <button onclick={() => showCreateThreadDialog = false} class="cancel-button">Cancel</button>
        <button 
          onclick={createDiscussionThread} 
          disabled={!newThreadTitle.trim() || creatingThread} 
          class="save-button"
        >
          {creatingThread ? 'Creating...' : 'Create'}
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- Reply Dialog -->
{#if showReplyDialog && userPubkey && replyingToThread}
  <div 
    class="modal-overlay" 
    role="dialog"
    aria-modal="true"
    aria-label="Reply to discussion"
    onclick={() => showReplyDialog = false}
    onkeydown={(e) => e.key === 'Escape' && (showReplyDialog = false)}
    tabindex="-1"
  >
    <div 
      class="modal" 
      role="dialog"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
      tabindex="-1"
    >
      <h3>{replyingToComment ? 'Reply to Comment' : 'Reply to Thread'}</h3>
      <label>
        Reply:
        <textarea bind:value={replyContent} rows="6" placeholder="Your reply..."></textarea>
      </label>
      <div class="modal-actions">
        <button onclick={() => showReplyDialog = false} class="cancel-button">Cancel</button>
        <button 
          onclick={createThreadReply} 
          disabled={!replyContent.trim() || creatingReply} 
          class="save-button"
        >
          {creatingReply ? 'Posting...' : 'Post Reply'}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .discussions-sidebar {
    height: 100%;
    overflow-y: auto;
  }

  .discussions-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 1rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid var(--border-color, #e0e0e0);
  }

  .discussions-header h2 {
    margin: 0;
    font-size: 1.25rem;
  }

  .create-discussion-button {
    background: none;
    border: none;
    cursor: pointer;
    padding: 0.25rem;
    display: flex;
    align-items: center;
  }

  .create-discussion-button:hover {
    opacity: 0.7;
  }

  .create-discussion-button .icon {
    width: 20px;
    height: 20px;
  }

  .discussion-list {
    list-style: none;
    padding: 0;
    margin: 0;
  }

  .discussion-item {
    margin-bottom: 0.5rem;
  }

  .discussion-item-button {
    width: 100%;
    text-align: left;
    padding: 0.75rem;
    background: var(--item-bg, #fff);
    border: 1px solid var(--border-color, #e0e0e0);
    border-radius: 4px;
    cursor: pointer;
    transition: background 0.2s;
  }

  .discussion-item-button:hover {
    background: var(--item-hover-bg, #f5f5f5);
  }

  .discussion-item.selected .discussion-item-button {
    background: var(--selected-bg, #e3f2fd);
    border-color: var(--selected-border, #2196f3);
  }

  .discussion-header {
    margin-bottom: 0.5rem;
  }

  .discussion-title {
    font-weight: 600;
    font-size: 1rem;
  }

  .discussion-meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.875rem;
    color: var(--text-secondary, #666);
  }

  .discussion-type {
    padding: 0.125rem 0.5rem;
    background: var(--type-bg, #e0e0e0);
    border-radius: 4px;
    font-size: 0.75rem;
  }

  .comment-count {
    font-weight: 500;
  }

  .empty-state {
    padding: 2rem;
    text-align: center;
    color: var(--text-secondary, #666);
  }

  .error {
    padding: 1rem;
    background: var(--error-bg, #ffebee);
    color: var(--error-color, #c62828);
    border-radius: 4px;
    margin-bottom: 1rem;
  }

  .modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .modal {
    background: var(--modal-bg, #fff);
    border-radius: 8px;
    padding: 1.5rem;
    max-width: 500px;
    width: 90%;
    max-height: 90vh;
    overflow-y: auto;
  }

  .modal h3 {
    margin: 0 0 1rem 0;
  }

  .modal label {
    display: block;
    margin-bottom: 1rem;
  }

  .modal label input,
  .modal label textarea {
    width: 100%;
    padding: 0.5rem;
    margin-top: 0.25rem;
    border: 1px solid var(--border-color, #e0e0e0);
    border-radius: 4px;
  }

  .modal-actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
  }

  .cancel-button,
  .save-button {
    padding: 0.5rem 1rem;
    border: none;
    border-radius: 4px;
    cursor: pointer;
  }

  .cancel-button {
    background: var(--cancel-bg, #e0e0e0);
  }

  .save-button {
    background: var(--primary-color, #2196f3);
    color: white;
  }

  .save-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
