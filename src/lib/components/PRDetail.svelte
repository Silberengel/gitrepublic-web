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
    isMaintainer?: boolean;
    userPubkeyHex?: string;
    onStatusUpdate?: () => void;
  }

  let { pr, npub, repo, repoOwnerPubkey, isMaintainer = false, userPubkeyHex, onStatusUpdate }: Props = $props();

  let highlights = $state<Array<{
    id: string;
    content: string;
    pubkey: string;
    created_at: number;
    comments?: Array<{
      id: string;
      content: string;
      pubkey: string;
      created_at: number;
      [key: string]: unknown;
    }>;
    [key: string]: unknown;
  }>>([]);
  let comments = $state<Array<{
    id: string;
    content: string;
    pubkey: string;
    created_at: number;
    [key: string]: unknown;
  }>>([]);
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
  
  // Status management
  let updatingStatus = $state(false);
  let merging = $state(false);
  let showMergeDialog = $state(false);
  let mergeTargetBranch = $state('main');
  let mergeMessage = $state('');

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
        prDiff = data.map((d: { file: string; diff: string }) => 
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

  async function updatePRStatus(status: 'open' | 'merged' | 'closed' | 'draft') {
    if (!userPubkeyHex || !isMaintainer) {
      alert('Only repository maintainers can update PR status');
      return;
    }

    updatingStatus = true;
    error = null;

    try {
      const response = await fetch(`/api/repos/${npub}/${repo}/prs`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prId: pr.id,
          prAuthor: pr.author,
          status
        })
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to update PR status');
      }

      if (onStatusUpdate) {
        onStatusUpdate();
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to update PR status';
      console.error('Error updating PR status:', err);
    } finally {
      updatingStatus = false;
    }
  }

  async function mergePR() {
    if (!userPubkeyHex || !isMaintainer) {
      alert('Only repository maintainers can merge PRs');
      return;
    }

    if (!pr.commitId) {
      alert('PR does not have a commit ID');
      return;
    }

    merging = true;
    error = null;

    try {
      const response = await fetch(`/api/repos/${npub}/${repo}/prs/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prId: pr.id,
          prAuthor: pr.author,
          prCommitId: pr.commitId,
          targetBranch: mergeTargetBranch,
          mergeMessage: mergeMessage.trim() || `Merge pull request ${pr.id.slice(0, 7)}`
        })
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to merge PR');
      }

      showMergeDialog = false;
      mergeMessage = '';
      if (onStatusUpdate) {
        onStatusUpdate();
      }
      alert('PR merged successfully!');
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to merge PR';
      console.error('Error merging PR:', err);
    } finally {
      merging = false;
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
    {#if isMaintainer && userPubkeyHex}
      <div class="pr-actions">
        {#if pr.status === 'open'}
          <button onclick={() => showMergeDialog = true} disabled={merging || !pr.commitId} class="action-btn merge-btn">
            {merging ? 'Merging...' : 'Merge'}
          </button>
          <button onclick={() => updatePRStatus('closed')} disabled={updatingStatus} class="action-btn close-btn">
            {updatingStatus ? 'Closing...' : 'Close'}
          </button>
        {:else if pr.status === 'closed'}
          <button onclick={() => updatePRStatus('open')} disabled={updatingStatus} class="action-btn reopen-btn">
            {updatingStatus ? 'Reopening...' : 'Reopen'}
          </button>
        {/if}
        {#if pr.status !== 'draft'}
          <button onclick={() => updatePRStatus('draft')} disabled={updatingStatus} class="action-btn draft-btn">
            {updatingStatus ? 'Updating...' : 'Mark as Draft'}
          </button>
        {/if}
      </div>
    {/if}
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
  <div 
    class="modal-overlay" 
    role="dialog"
    aria-modal="true"
    aria-label="Create highlight"
    tabindex="-1"
    onclick={() => showHighlightDialog = false}
    onkeydown={(e) => {
      if (e.key === 'Escape') {
        showHighlightDialog = false;
      }
    }}
  >
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div class="modal" role="document" onclick={(e) => e.stopPropagation()}>
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
  <div 
    class="modal-overlay" 
    role="dialog"
    aria-modal="true"
    aria-label={replyingTo ? 'Reply to comment' : 'Add comment'}
    tabindex="-1"
    onclick={() => { showCommentDialog = false; replyingTo = null; }}
    onkeydown={(e) => {
      if (e.key === 'Escape') {
        showCommentDialog = false;
        replyingTo = null;
      }
    }}
  >
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div class="modal" role="document" onclick={(e) => e.stopPropagation()}>
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
    border-bottom: 1px solid var(--border-color);
  }

  .pr-header h2 {
    margin: 0 0 0.5rem 0;
    color: var(--text-primary);
  }

  .pr-meta {
    display: flex;
    gap: 1rem;
    font-size: 0.9rem;
    color: var(--text-muted);
  }

  .pr-status {
    padding: 0.2rem 0.5rem;
    border-radius: 3px;
    font-weight: bold;
    font-size: 0.8rem;
  }

  .pr-status.open {
    background: var(--accent-light);
    color: var(--accent);
  }

  .pr-status.closed {
    background: var(--error-bg);
    color: var(--error-text);
  }

  .pr-status.merged {
    background: var(--success-bg);
    color: var(--success-text);
  }

  .pr-body {
    margin-bottom: 2rem;
  }

  .pr-description {
    padding: 1rem;
    background: var(--bg-secondary);
    border-radius: 4px;
    color: var(--text-primary);
  }

  .pr-content {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 2rem;
  }

  .code-section, .highlights-section {
    border: 1px solid var(--border-color);
    border-radius: 4px;
    padding: 1rem;
    background: var(--card-bg);
  }

  .code-section h3, .highlights-section h3 {
    margin-top: 0;
    color: var(--text-primary);
  }

  .diff-viewer {
    height: 500px;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    overflow: auto;
    background: var(--bg-secondary);
  }

  .section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
  }

  .add-comment-btn, .reply-btn {
    padding: 0.4rem 0.8rem;
    background: var(--button-primary);
    color: var(--accent-text, #ffffff);
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.9rem;
    font-family: 'IBM Plex Serif', serif;
    transition: background 0.2s ease;
  }

  .add-comment-btn:hover, .reply-btn:hover {
    background: var(--button-primary-hover);
  }

  .highlight-item, .comment-item {
    margin-bottom: 1.5rem;
    padding: 1rem;
    background: var(--bg-secondary);
    border-radius: 4px;
    border-left: 3px solid var(--accent);
  }

  .comment-item.nested {
    margin-left: 2rem;
    margin-top: 0.5rem;
    border-left-color: var(--success-text);
  }

  .highlight-header, .comment-header {
    display: flex;
    gap: 1rem;
    margin-bottom: 0.5rem;
    font-size: 0.9rem;
    color: var(--text-muted);
  }

  .highlight-author, .comment-author {
    font-weight: bold;
    color: var(--text-primary);
  }

  .highlighted-code {
    background: var(--card-bg);
    padding: 0.5rem;
    border-radius: 3px;
    margin: 0.5rem 0;
    border: 1px solid var(--border-light);
  }

  .highlighted-code pre {
    margin: 0;
    font-size: 0.9rem;
    color: var(--text-primary);
    font-family: 'IBM Plex Mono', monospace;
  }

  .highlight-comment, .comment-content {
    margin: 0.5rem 0;
    padding: 0.5rem;
    background: var(--card-bg);
    border-radius: 3px;
    color: var(--text-primary);
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
    background: var(--card-bg);
    padding: 2rem;
    border-radius: 8px;
    max-width: 600px;
    width: 90%;
    max-height: 80vh;
    overflow-y: auto;
    border: 1px solid var(--border-color);
  }

  .modal h3 {
    color: var(--text-primary);
  }

  .modal label {
    color: var(--text-primary);
  }

  .modal textarea {
    background: var(--input-bg);
    border: 1px solid var(--input-border);
    color: var(--text-primary);
    font-family: 'IBM Plex Serif', serif;
  }

  .modal textarea:focus {
    outline: none;
    border-color: var(--input-focus);
  }

  .selected-code {
    background: var(--bg-secondary);
    padding: 1rem;
    border-radius: 4px;
    margin-bottom: 1rem;
    max-height: 200px;
    overflow: auto;
    border: 1px solid var(--border-light);
  }

  .selected-code pre {
    margin: 0;
    color: var(--text-primary);
    font-family: 'IBM Plex Mono', monospace;
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
    font-family: 'IBM Plex Serif', serif;
    transition: background 0.2s ease;
  }

  .cancel-btn {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .cancel-btn:hover {
    background: var(--bg-secondary);
  }

  .save-btn {
    background: var(--button-primary);
    color: white;
  }

  .save-btn:hover:not(:disabled) {
    background: var(--button-primary-hover);
  }

  .save-btn:disabled {
    background: var(--text-muted);
    cursor: not-allowed;
    opacity: 0.6;
  }

  .loading, .empty, .error {
    color: var(--text-muted);
    text-align: center;
    padding: 1rem;
  }

  .error {
    color: var(--error-text);
    background: var(--error-bg);
    border: 1px solid var(--error-text);
    border-radius: 4px;
  }

  .pr-actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 1rem;
    flex-wrap: wrap;
  }

  .action-btn {
    padding: 0.5rem 1rem;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-family: 'IBM Plex Serif', serif;
    font-size: 0.9rem;
    transition: background 0.2s ease;
  }

  .action-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .merge-btn {
    background: var(--success-text, #28a745);
    color: white;
  }

  .merge-btn:hover:not(:disabled) {
    background: var(--success-hover, #218838);
  }

  .close-btn {
    background: var(--error-text, #dc3545);
    color: white;
  }

  .close-btn:hover:not(:disabled) {
    background: var(--error-hover, #c82333);
  }

  .reopen-btn {
    background: var(--accent, #007bff);
    color: white;
  }

  .reopen-btn:hover:not(:disabled) {
    background: var(--accent-hover, #0056b3);
  }

  .draft-btn {
    background: var(--bg-tertiary, #6c757d);
    color: white;
  }

  .draft-btn:hover:not(:disabled) {
    background: var(--bg-secondary, #5a6268);
  }

  @media (max-width: 768px) {
    .pr-actions {
      flex-direction: column;
    }

    .action-btn {
      width: 100%;
    }

    .pr-content {
      grid-template-columns: 1fr;
    }
  }
</style>

<!-- Merge Dialog -->
{#if showMergeDialog}
  <div 
    class="modal-overlay" 
    role="dialog"
    aria-modal="true"
    aria-label="Merge pull request"
    tabindex="-1"
    onclick={() => showMergeDialog = false}
    onkeydown={(e) => {
      if (e.key === 'Escape') {
        showMergeDialog = false;
      }
    }}
  >
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div class="modal" role="document" onclick={(e) => e.stopPropagation()}>
      <h3>Merge Pull Request</h3>
      <label>
        Target Branch:
        <input type="text" bind:value={mergeTargetBranch} placeholder="main" />
      </label>
      <label>
        Merge Message (optional):
        <textarea bind:value={mergeMessage} rows="3" placeholder="Merge pull request..."></textarea>
      </label>
      <div class="modal-actions">
        <button onclick={() => { showMergeDialog = false; mergeMessage = ''; }} class="cancel-btn">Cancel</button>
        <button onclick={mergePR} disabled={merging || !mergeTargetBranch.trim()} class="save-btn">
          {merging ? 'Merging...' : 'Merge'}
        </button>
      </div>
    </div>
  </div>
{/if}
