<script lang="ts">
  /**
   * Commit history tab component
   */
  
  import TabLayout from './TabLayout.svelte';
  
  interface Props {
    commits?: Array<{
      hash: string;
      message: string;
      author: string;
      date: string;
      files: string[];
      verification?: any;
    }>;
    selectedCommit?: string | null;
    loading?: boolean;
    error?: string | null;
    onSelect?: (hash: string) => void;
    onVerify?: (hash: string) => void;
    verifyingCommits?: Set<string>;
    showDiff?: boolean;
    diffData?: Array<{ file: string; additions: number; deletions: number; diff: string }>;
  }
  
  let {
    commits = [],
    selectedCommit = null,
    loading = false,
    error = null,
    onSelect = () => {},
    onVerify = () => {},
    verifyingCommits = new Set(),
    showDiff = false,
    diffData = []
  }: Props = $props();
</script>

<TabLayout {loading} {error}>
  {#snippet leftPane()}
    <div class="commits-list">
      <h3>Commits</h3>
      {#if commits.length === 0}
        <div class="empty">No commits found</div>
      {:else}
        <ul class="commit-list">
          {#each commits as commit}
            <li>
              <button
                class="commit-item {selectedCommit === commit.hash ? 'selected' : ''}"
                onclick={() => onSelect(commit.hash)}
              >
                <div class="commit-hash">{commit.hash.slice(0, 7)}</div>
                <div class="commit-message">{commit.message || 'No message'}</div>
                <div class="commit-meta">
                  <span>{commit.author}</span>
                  <span>{new Date(commit.date).toLocaleString()}</span>
                </div>
                {#if commit.verification}
                  <div class="commit-verification">
                    {#if commit.verification.valid}
                      <span class="verified">✓ Verified</span>
                    {:else}
                      <span class="unverified">✗ {commit.verification.error || 'Invalid'}</span>
                    {/if}
                  </div>
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/snippet}
  
  {#snippet rightPanel()}
    {#if selectedCommit}
      {@const commit = commits.find(c => c.hash === selectedCommit)}
      {#if commit}
        <div class="commit-detail">
          <div class="commit-detail-header">
            <h2>Commit {commit.hash.slice(0, 7)}</h2>
            <button
              onclick={() => onVerify(commit.hash)}
              disabled={verifyingCommits.has(commit.hash)}
            >
              {verifyingCommits.has(commit.hash) ? 'Verifying...' : 'Verify Signature'}
            </button>
          </div>
          
          <div class="commit-info">
            <div class="info-row">
              <strong>Author:</strong> {commit.author}
            </div>
            <div class="info-row">
              <strong>Date:</strong> {new Date(commit.date).toLocaleString()}
            </div>
            <div class="info-row">
              <strong>Message:</strong>
              <div class="commit-message-text">{commit.message || 'No message'}</div>
            </div>
            {#if commit.files && commit.files.length > 0}
              <div class="info-row">
                <strong>Files ({commit.files.length}):</strong>
                <ul class="files-list">
                  {#each commit.files as file}
                    <li>{file}</li>
                  {/each}
                </ul>
              </div>
            {/if}
          </div>
          
          {#if showDiff && diffData.length > 0}
            <div class="diff-section">
              <h3>Changes</h3>
              {#each diffData as diff}
                <div class="diff-file">
                  <div class="diff-header">
                    <strong>{diff.file}</strong>
                    <span class="diff-stats">
                      +{diff.additions} -{diff.deletions}
                    </span>
                  </div>
                  <pre class="diff-content"><code>{diff.diff}</code></pre>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    {:else}
      <div class="empty-state">
        <p>Select a commit to view details</p>
      </div>
    {/if}
  {/snippet}
</TabLayout>

<style>
  .commits-list {
    padding: 1rem;
  }
  
  .commits-list h3 {
    margin: 0 0 1rem 0;
    font-size: 1rem;
    font-weight: 600;
  }
  
  .empty {
    padding: 2rem;
    text-align: center;
    color: var(--text-secondary);
  }
  
  .commit-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  
  .commit-item {
    width: 100%;
    padding: 0.75rem;
    text-align: left;
    background: transparent;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.2s;
  }
  
  .commit-item:hover {
    background: var(--bg-hover);
    border-color: var(--accent-color);
  }
  
  .commit-item.selected {
    background: var(--bg-selected);
    border-color: var(--accent-color);
  }
  
  .commit-hash {
    font-family: monospace;
    font-weight: 600;
    margin-bottom: 0.25rem;
  }
  
  .commit-message {
    margin: 0.25rem 0;
    font-weight: 500;
  }
  
  .commit-meta {
    display: flex;
    gap: 1rem;
    font-size: 0.85rem;
    color: var(--text-secondary);
    margin-top: 0.25rem;
  }
  
  .commit-verification {
    margin-top: 0.5rem;
  }
  
  .verified {
    color: var(--accent-success);
  }
  
  .unverified {
    color: var(--accent-error);
  }
  
  .commit-detail {
    padding: 1rem;
  }
  
  .commit-detail-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
    padding-bottom: 1rem;
    border-bottom: 1px solid var(--border-color);
  }
  
  .commit-info {
    margin: 1rem 0;
  }
  
  .info-row {
    margin: 1rem 0;
  }
  
  .commit-message-text {
    margin-top: 0.5rem;
    padding: 0.75rem;
    background: var(--bg-secondary);
    border-radius: 4px;
    white-space: pre-wrap;
  }
  
  .files-list {
    margin-top: 0.5rem;
    padding-left: 1.5rem;
  }
  
  .diff-section {
    margin-top: 2rem;
    padding-top: 2rem;
    border-top: 1px solid var(--border-color);
  }
  
  .diff-file {
    margin: 1rem 0;
  }
  
  .diff-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.5rem;
    background: var(--bg-secondary);
    border-radius: 4px 4px 0 0;
  }
  
  .diff-stats {
    font-family: monospace;
    font-size: 0.9rem;
  }
  
  .diff-content {
    margin: 0;
    padding: 1rem;
    background: var(--bg-secondary);
    border-radius: 0 0 4px 4px;
    overflow-x: auto;
    font-family: monospace;
    font-size: 0.85rem;
  }
</style>
