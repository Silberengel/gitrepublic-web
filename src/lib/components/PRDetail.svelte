<script lang="ts">
  import { onMount } from 'svelte';
  import CodeEditor from './CodeEditor.svelte';
  import { HighlightsService } from '../services/nostr/highlights-service.js';
  import { DEFAULT_NOSTR_RELAYS, combineRelays } from '../config.js';
  import { getUserRelays } from '../services/nostr/user-relays.js';
  import { NostrClient } from '../services/nostr/nostr-client.js';
  import { signEventWithNIP07 } from '../services/nostr/nip07-signer.js';
  import { getPublicKeyWithNIP07 } from '../services/nostr/nip07-signer.js';
  import { KIND } from '../types/nostr.js';
  import { nip19 } from 'nostr-tools';

  interface Props {
    pr: {
      id: string;
      subject: string;
      content: string;
      status: string;
      author: string;
      created_at: number;
      commitId?: string;
    };
    npub: string;
    repo: string;
    repoOwnerPubkey: string;
  }

  let { pr, npub, repo, repoOwnerPubkey }: Props = $props();

  let highlights = $state<Array<any>>([]);
  let comments = $state<Array<any>>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let userPubkey = $state<string | null>(null);
  
  // Highlight creation
  let selectedText = $state('');
  let selectedStartLine = $state(0);
  let selectedEndLine = $state(0);
  let selectedStartPos = $state(0);
  let selectedEndPos = $state(0);
  let showHighlightDialog = $state(false);
  let highlightComment = $state('');
  let creatingHighlight = $state(false);
  
  // Comment creation
  let showCommentDialog = $state(false);
  let commentContent = $state('');
  let replyingTo = $state<string | null>(null);
  let creatingComment = $state(false);
  
  // PR diff/file content
  let prDiff = $state('');
  let prFileContent = $state('');
  let currentFilePath = $state<string | null>(null);
  let loadingDiff = $state(false);

  const highlightsService = new HighlightsService(DEFAULT_NOSTR_RELAYS);
  const nostrClient = new NostrClient(DEFAULT_NOSTR_RELAYS);

  onMount(async () => {
    await checkAuth();
    await loadHighlights();
    await loadPRDiff();
  });

  async function checkAuth() {
    try {
      if (typeof window !== 'undefined' && window.nostr) {
        userPubkey = await getPublicKeyWithNIP07();
      }
    } catch (err) {
      console.error('Auth check failed:', err);
    }
  }

  async function loadHighlights() {
    loading = true;
    error = null;
    try {
      const response = await fetch(
        `/api/repos/${npub}/${repo}/highlights?prId=${pr.id}&prAuthor=${pr.author}`
      );
      if (response.ok) {
        const data = await response.json();
        highlights = data.highlights || [];
        comments = data.comments || [];
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load highlights';
    } finally {
      loading = false;
    }
  }

  async function loadPRDiff() {
    if (!pr.commitId) return;
    
    loadingDiff = true;
    try {
      // Load diff for the commit
      const response = await fetch(
        `/api/repos/${npub}/${repo}/diff?from=${pr.commitId}^&to=${pr.commitId}`
      );
      if (response.ok) {
        const data = await response.json();
        // Combine all file diffs
        prDiff = data.map((d: any) => 
          `--- ${d.file}\n+++ ${d.file}\n${d.diff}`
        ).join('\n\n');
      }
    } catch (err) {
      console.error('Failed to load PR diff:', err);
    } finally {
      loadingDiff = false;
    }
  }

  function handleCodeSelection(
    text: string,
    startLine: number,
    endLine: number,
    startPos: number,
    endPos: number
  ) {
    if (!text.trim() || !userPubkey) return;
    
    selectedText = text;
    selectedStartLine = startLine;
    selectedEndLine = endLine;
    selectedStartPos = startPos;
    selectedEndPos = endPos;
    showHighlightDialog = true;
  }

  async function createHighlight() {
    if (!userPubkey || !selectedText.trim()) return;

    creatingHighlight = true;
    error = null;

    try {
      const eventTemplate = highlightsService.createHighlightEvent(
        selectedText,
        pr.id,
        pr.author,
        repoOwnerPubkey,
        repo,
        currentFilePath || undefined,
        selectedStartLine,
        selectedEndLine,
        undefined, // context
        highlightComment.trim() || undefined
      );

      const signedEvent = await signEventWithNIP07(eventTemplate);
      
      const { outbox } = await getUserRelays(userPubkey, nostrClient);
      const combinedRelays = combineRelays(outbox);

      const response = await fetch(`/api/repos/${npub}/${repo}/highlights`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'highlight',
          event: signedEvent,
          userPubkey
        })
      });

      if (response.ok) {
        showHighlightDialog = false;
        selectedText = '';
        highlightComment = '';
        await loadHighlights();
      } else {
        const data = await response.json();
        error = data.error || 'Failed to create highlight';
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to create highlight';
    } finally {
      creatingHighlight = false;
    }
  }

  function startComment(parentId?: string) {
    if (!userPubkey) {
      alert('Please connect your NIP-07 extension');
      return;
    }
    replyingTo = parentId || null;
    showCommentDialog = true;
  }

  async function createComment() {
    if (!userPubkey || !commentContent.trim()) return;

    creatingComment = true;
    error = null;

    try {
      const rootEventId = replyingTo || pr.id;
      const rootEventKind = replyingTo ? KIND.COMMENT : KIND.PULL_REQUEST;
      const rootPubkey = replyingTo ? 
        (comments.find(c => c.id === replyingTo)?.pubkey || pr.author) :
        pr.author;

      let parentEventId: string | undefined;
      let parentEventKind: number | undefined;
      let parentPubkey: string | undefined;

      if (replyingTo) {
        // Reply to a comment
        const parentComment = comments.find(c => c.id === replyingTo) || 
                             highlights.flatMap(h => h.comments || []).find(c => c.id === replyingTo);
        if (parentComment) {
          parentEventId = replyingTo;
          parentEventKind = KIND.COMMENT;
          parentPubkey = parentComment.pubkey;
        }
      }

      const eventTemplate = highlightsService.createCommentEvent(
        commentContent.trim(),
        rootEventId,
        rootEventKind,
        rootPubkey,
        parentEventId,
        parentEventKind,
        parentPubkey
      );

      const signedEvent = await signEventWithNIP07(eventTemplate);
      
      const { outbox } = await getUserRelays(userPubkey, nostrClient);
      const combinedRelays = combineRelays(outbox);

      const response = await fetch(`/api/repos/${npub}/${repo}/highlights`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'comment',
          event: signedEvent,
          userPubkey
        })
      });

      if (response.ok) {
        showCommentDialog = false;
        commentContent = '';
        replyingTo = null;
        await loadHighlights();
      } else {
        const data = await response.json();
        error = data.error || 'Failed to create comment';
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to create comment';
    } finally {
      creatingComment = false;
    }
  }

  function formatPubkey(pubkey: string): string {
    try {
      return nip19.npubEncode(pubkey);
    } catch {
      return pubkey.slice(0, 8) + '...';
    }
  }
</script>

<div class="pr-detail-view">
  <div class="pr-header">
    <h2>{pr.subject}</h2>
    <div class="pr-meta">
      <span class="pr-status" class:open={pr.status === 'open'} class:closed={pr.status === 'closed'} class:merged={pr.status === 'merged'}>
        {pr.status}
      </span>
      {#if pr.commitId}
        <span>Commit: {pr.commitId.slice(0, 7)}</span>
      {/if}
      <span>Created {new Date(pr.created_at * 1000).toLocaleString()}</span>
    </div>
  </div>

  <div class="pr-body">
    <div class="pr-description">
      {@html pr.content.replace(/\n/g, '<br>')}
    </div>
  </div>

  {#if error}
    <div class="error">{error}</div>
  {/if}

  <div class="pr-content">
    <div class="code-section">
      <h3>Changes</h3>
      {#if loadingDiff}
        <div class="loading">Loading diff...</div>
      {:else if prDiff}
        <div class="diff-viewer">
          <CodeEditor
            content={prDiff}
            language="text"
            readOnly={true}
            onSelection={handleCodeSelection}
          />
        </div>
      {:else}
        <div class="empty">No diff available</div>
      {/if}
    </div>

    <div class="highlights-section">
      <div class="section-header">
        <h3>Highlights & Comments</h3>
        {#if userPubkey}
          <button onclick={() => startComment()} class="add-comment-btn">Add Comment</button>
        {/if}
      </div>

      {#if loading}
        <div class="loading">Loading highlights...</div>
      {:else}
        <!-- Top-level comments on PR -->
        {#each comments as comment}
          <div class="comment-item">
            <div class="comment-header">
              <span class="comment-author">{formatPubkey(comment.pubkey)}</span>
              <span class="comment-date">{new Date(comment.created_at * 1000).toLocaleString()}</span>
            </div>
            <div class="comment-content">{comment.content}</div>
            {#if userPubkey}
              <button onclick={() => startComment(comment.id)} class="reply-btn">Reply</button>
            {/if}
          </div>
        {/each}

        <!-- Highlights with comments -->
        {#each highlights as highlight}
          <div class="highlight-item">
            <div class="highlight-header">
              <span class="highlight-author">{formatPubkey(highlight.pubkey)}</span>
              <span class="highlight-date">{new Date(highlight.created_at * 1000).toLocaleString()}</span>
              {#if highlight.file}
                <span class="highlight-file">{highlight.file}</span>
              {/if}
              {#if highlight.lineStart}
                <span class="highlight-lines">Lines {highlight.lineStart}-{highlight.lineEnd}</span>
              {/if}
            </div>
            <div class="highlighted-code">
              <pre><code>{highlight.highlightedContent}</code></pre>
            </div>
            {#if highlight.comment}
              <div class="highlight-comment">{highlight.comment}</div>
            {/if}
            
            <!-- Comments on this highlight -->
            {#if highlight.comments && highlight.comments.length > 0}
              <div class="highlight-comments">
                {#each highlight.comments as comment}
                  <div class="comment-item nested">
                    <div class="comment-header">
                      <span class="comment-author">{formatPubkey(comment.pubkey)}</span>
                      <span class="comment-date">{new Date(comment.created_at * 1000).toLocaleString()}</span>
                    </div>
                    <div class="comment-content">{comment.content}</div>
                    {#if userPubkey}
                      <button onclick={() => startComment(comment.id)} class="reply-btn">Reply</button>
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}
            
            {#if userPubkey}
              <button onclick={() => startComment(highlight.id)} class="add-comment-btn">Add Comment</button>
            {/if}
          </div>
        {/each}

        {#if highlights.length === 0 && comments.length === 0}
          <div class="empty">No highlights or comments yet</div>
        {/if}
      {/if}
    </div>
  </div>
</div>

<!-- Highlight Dialog -->
{#if showHighlightDialog}
  <div class="modal-overlay" onclick={() => showHighlightDialog = false}>
    <div class="modal" onclick={(e) => e.stopPropagation()}>
      <h3>Create Highlight</h3>
      <div class="selected-code">
        <pre><code>{selectedText}</code></pre>
      </div>
      <label>
        Comment (optional):
        <textarea bind:value={highlightComment} rows="4" placeholder="Add a comment about this code..."></textarea>
      </label>
      <div class="modal-actions">
        <button onclick={() => showHighlightDialog = false} class="cancel-btn">Cancel</button>
        <button onclick={createHighlight} disabled={creatingHighlight} class="save-btn">
          {creatingHighlight ? 'Creating...' : 'Create Highlight'}
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- Comment Dialog -->
{#if showCommentDialog}
  <div class="modal-overlay" onclick={() => { showCommentDialog = false; replyingTo = null; }}>
    <div class="modal" onclick={(e) => e.stopPropagation()}>
      <h3>{replyingTo ? 'Reply to Comment' : 'Add Comment'}</h3>
      <label>
        Comment:
        <textarea bind:value={commentContent} rows="6" placeholder="Write your comment..."></textarea>
      </label>
      <div class="modal-actions">
        <button onclick={() => { showCommentDialog = false; replyingTo = null; }} class="cancel-btn">Cancel</button>
        <button onclick={createComment} disabled={creatingComment || !commentContent.trim()} class="save-btn">
          {creatingComment ? 'Posting...' : 'Post Comment'}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .pr-detail-view {
    padding: 1rem;
  }

  .pr-header {
    margin-bottom: 1rem;
    padding-bottom: 1rem;
    border-bottom: 1px solid #e0e0e0;
  }

  .pr-header h2 {
    margin: 0 0 0.5rem 0;
  }

  .pr-meta {
    display: flex;
    gap: 1rem;
    font-size: 0.9rem;
    color: #666;
  }

  .pr-status {
    padding: 0.2rem 0.5rem;
    border-radius: 3px;
    font-weight: bold;
    font-size: 0.8rem;
  }

  .pr-status.open {
    background: #d4edda;
    color: #155724;
  }

  .pr-status.closed {
    background: #f8d7da;
    color: #721c24;
  }

  .pr-status.merged {
    background: #d1ecf1;
    color: #0c5460;
  }

  .pr-body {
    margin-bottom: 2rem;
  }

  .pr-description {
    padding: 1rem;
    background: #f5f5f5;
    border-radius: 4px;
  }

  .pr-content {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 2rem;
  }

  .code-section, .highlights-section {
    border: 1px solid #e0e0e0;
    border-radius: 4px;
    padding: 1rem;
  }

  .code-section h3, .highlights-section h3 {
    margin-top: 0;
  }

  .diff-viewer {
    height: 500px;
    border: 1px solid #ddd;
    border-radius: 4px;
    overflow: auto;
  }

  .section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
  }

  .add-comment-btn, .reply-btn {
    padding: 0.4rem 0.8rem;
    background: #007bff;
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.9rem;
  }

  .add-comment-btn:hover, .reply-btn:hover {
    background: #0056b3;
  }

  .highlight-item, .comment-item {
    margin-bottom: 1.5rem;
    padding: 1rem;
    background: #f9f9f9;
    border-radius: 4px;
    border-left: 3px solid #007bff;
  }

  .comment-item.nested {
    margin-left: 2rem;
    margin-top: 0.5rem;
    border-left-color: #28a745;
  }

  .highlight-header, .comment-header {
    display: flex;
    gap: 1rem;
    margin-bottom: 0.5rem;
    font-size: 0.9rem;
    color: #666;
  }

  .highlight-author, .comment-author {
    font-weight: bold;
    color: #333;
  }

  .highlighted-code {
    background: #fff;
    padding: 0.5rem;
    border-radius: 3px;
    margin: 0.5rem 0;
  }

  .highlighted-code pre {
    margin: 0;
    font-size: 0.9rem;
  }

  .highlight-comment, .comment-content {
    margin: 0.5rem 0;
    padding: 0.5rem;
    background: white;
    border-radius: 3px;
  }

  .highlight-comments {
    margin-top: 1rem;
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
    background: white;
    padding: 2rem;
    border-radius: 8px;
    max-width: 600px;
    width: 90%;
    max-height: 80vh;
    overflow-y: auto;
  }

  .selected-code {
    background: #f5f5f5;
    padding: 1rem;
    border-radius: 4px;
    margin-bottom: 1rem;
    max-height: 200px;
    overflow: auto;
  }

  .selected-code pre {
    margin: 0;
  }

  .modal-actions {
    display: flex;
    gap: 1rem;
    justify-content: flex-end;
    margin-top: 1rem;
  }

  .cancel-btn, .save-btn {
    padding: 0.5rem 1rem;
    border: none;
    border-radius: 4px;
    cursor: pointer;
  }

  .cancel-btn {
    background: #6c757d;
    color: white;
  }

  .save-btn {
    background: #007bff;
    color: white;
  }

  .save-btn:disabled {
    background: #ccc;
    cursor: not-allowed;
  }

  .loading, .empty {
    padding: 2rem;
    text-align: center;
    color: #666;
  }

  .error {
    padding: 1rem;
    background: #f8d7da;
    color: #721c24;
    border-radius: 4px;
    margin-bottom: 1rem;
  }
</style>
