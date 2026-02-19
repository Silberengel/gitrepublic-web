<script lang="ts">
  import { onMount } from 'svelte';
  import { getPublicKeyWithNIP07, isNIP07Available } from '$lib/services/nostr/nip07-signer.js';
  import { nip19 } from 'nostr-tools';
  import type { ExternalIssue, ExternalPullRequest } from '$lib/services/git-platforms/git-platform-fetcher.js';
  import { userStore } from '$lib/stores/user-store.js';

  let loading = $state(true);
  let error = $state<string | null>(null);
  let userPubkeyHex = $state<string | null>(null);

  // Sync with userStore
  $effect(() => {
    const currentUser = $userStore;
    if (currentUser.userPubkeyHex) {
      userPubkeyHex = currentUser.userPubkeyHex;
    } else {
      userPubkeyHex = null;
    }
  });
  let issues = $state<ExternalIssue[]>([]);
  let pullRequests = $state<ExternalPullRequest[]>([]);
  let activeTab = $state<'issues' | 'prs' | 'all'>('all');

  const PLATFORM_NAMES: Record<string, string> = {
    github: 'GitHub',
    gitlab: 'GitLab',
    gitea: 'Gitea',
    codeberg: 'Codeberg',
    forgejo: 'Forgejo',
    onedev: 'OneDev',
    custom: 'Custom'
  };

  onMount(async () => {
    await loadUserPubkey();
    if (userPubkeyHex) {
      await loadDashboard();
    } else {
      loading = false;
      error = 'Please connect your NIP-07 extension to view the dashboard';
    }
  });

  async function loadUserPubkey() {
    // Check userStore first
    const currentUser = $userStore;
    if (currentUser.userPubkeyHex) {
      userPubkeyHex = currentUser.userPubkeyHex;
      return;
    }
    
    // Fallback: try NIP-07 if store doesn't have it
    if (!isNIP07Available()) {
      return;
    }

    try {
      const pubkey = await getPublicKeyWithNIP07();
      try {
        const decoded = nip19.decode(pubkey);
        if (decoded.type === 'npub') {
          userPubkeyHex = decoded.data as string;
        } else {
          userPubkeyHex = pubkey;
        }
      } catch {
        userPubkeyHex = pubkey;
      }
    } catch (err) {
      console.warn('Failed to load user pubkey:', err);
    }
  }

  async function loadDashboard() {
    if (!userPubkeyHex) return;

    loading = true;
    error = null;

    try {
      const response = await fetch('/api/user/git-dashboard', {
        headers: {
          'X-User-Pubkey': userPubkeyHex
        }
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || `Failed to load dashboard: ${response.statusText}`);
      }

      const data = await response.json();
      issues = data.issues || [];
      pullRequests = data.pullRequests || [];
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load dashboard';
      console.error('Error loading dashboard:', err);
    } finally {
      loading = false;
    }
  }

  function getPlatformName(platform: string): string {
    return PLATFORM_NAMES[platform] || platform;
  }

  function getPlatformIcon(platform: string): string {
    const icons: Record<string, string> = {
      github: '/icons/github.svg',
      gitlab: '/icons/gitlab.svg',
      gitea: '/icons/git-branch.svg',
      codeberg: '/icons/git-branch.svg',
      forgejo: '/icons/hammer.svg',
      onedev: '/icons/package.svg',
      custom: '/icons/settings.svg'
    };
    return icons[platform] || '/icons/package.svg';
  }

  function formatDate(dateString: string): string {
    if (!dateString) return 'Unknown';
    try {
      const date = new Date(dateString);
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const diffDays = Math.floor(diffMs / 86400000);

      if (diffMins < 1) return 'Just now';
      if (diffMins < 60) return `${diffMins}m ago`;
      if (diffHours < 24) return `${diffHours}h ago`;
      if (diffDays < 7) return `${diffDays}d ago`;
      return date.toLocaleDateString();
    } catch {
      return dateString;
    }
  }

  function getRepoDisplay(issue: ExternalIssue | ExternalPullRequest): string {
    return `${issue.owner}/${issue.repo}`;
  }

  const filteredItems = $derived(() => {
    if (activeTab === 'issues') {
      return issues;
    } else if (activeTab === 'prs') {
      return pullRequests;
    } else {
      // Combine and sort by updated_at
      const all = [
        ...issues.map(i => ({ ...i, type: 'issue' as const })),
        ...pullRequests.map(pr => ({ ...pr, type: 'pr' as const }))
      ];
      return all.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
    }
  });
</script>

<div class="dashboard-container">
  <header class="dashboard-header">
    <h1>Universal Git Dashboard</h1>
    <p class="dashboard-subtitle">Aggregated issues and pull requests from all your configured git platforms</p>
    {#if userPubkeyHex}
      <button onclick={loadDashboard} class="refresh-button" disabled={loading}>
        {#if loading}
          Refreshing...
        {:else}
          <img src="/icons/refresh-cw.svg" alt="Refresh" class="icon-inline" />
          Refresh
        {/if}
      </button>
    {/if}
  </header>

  {#if loading}
    <div class="loading">Loading dashboard...</div>
  {:else if error}
    <div class="error">
      <p>{error}</p>
      {#if !userPubkeyHex}
        <p>Please connect your NIP-07 extension to view the dashboard.</p>
      {/if}
    </div>
  {:else if issues.length === 0 && pullRequests.length === 0}
    <div class="empty-state">
      <h2>No items found</h2>
      <p>Configure git platform forwarding in your messaging preferences to see issues and pull requests here.</p>
      {#if userPubkeyHex}
        <p>Go to your <a href="/users/{nip19.npubEncode(userPubkeyHex)}">profile</a> to configure platforms.</p>
      {/if}
    </div>
  {:else}
    <!-- Tabs -->
    <div class="tabs">
      <button 
        class="tab-button" 
        class:active={activeTab === 'all'}
        onclick={() => activeTab = 'all'}
      >
        All ({issues.length + pullRequests.length})
      </button>
      <button 
        class="tab-button" 
        class:active={activeTab === 'issues'}
        onclick={() => activeTab = 'issues'}
      >
        Issues ({issues.length})
      </button>
      <button 
        class="tab-button" 
        class:active={activeTab === 'prs'}
        onclick={() => activeTab = 'prs'}
      >
        Pull Requests ({pullRequests.length})
      </button>
    </div>

    <!-- Items List -->
    <div class="items-list">
      {#each filteredItems() as item}
        {@const isPR = 'head' in item}
        <div class="item-card" class:pr={isPR} class:issue={!isPR}>
          <div class="item-header">
            <div class="item-title-row">
              <span class="item-type-badge" class:pr={isPR} class:issue={!isPR}>
                {#if isPR}
                  <img src="/icons/git-pull-request.svg" alt="PR" class="icon-inline" />
                  PR
                {:else}
                  <img src="/icons/clipboard-list.svg" alt="Issue" class="icon-inline" />
                  Issue
                {/if}
              </span>
              <a 
                href={item.html_url} 
                target="_blank" 
                rel="noopener noreferrer"
                class="item-title"
              >
                {item.title || 'Untitled'}
              </a>
            </div>
            <div class="item-meta">
              <span class="platform-badge" title={item.apiUrl || ''}>
                <img src={getPlatformIcon(item.platform)} alt={getPlatformName(item.platform)} class="icon-inline" />
                {getPlatformName(item.platform)}
              </span>
              <span class="repo-name">{getRepoDisplay(item)}</span>
              {#if item.number}
                <span class="item-number">#{item.number}</span>
              {/if}
            </div>
          </div>
          
          <div class="item-body">
            <p class="item-description">
              {item.body ? (item.body.length > 200 ? item.body.slice(0, 200) + '...' : item.body) : 'No description'}
            </p>
          </div>

          <div class="item-footer">
            <div class="item-status">
              <span class="status-badge" class:open={item.state === 'open'} class:closed={item.state === 'closed'} class:merged={item.state === 'merged'}>
                {item.state}
              </span>
              {#if isPR && 'merged_at' in item && item.merged_at}
                <span class="merged-indicator">✓ Merged</span>
              {/if}
            </div>
            <div class="item-info">
              {#if item.user.login || item.user.username}
                <span class="item-author">@{item.user.login || item.user.username}</span>
              {/if}
              <span class="item-date">Updated {formatDate(item.updated_at)}</span>
              {#if item.comments_count !== undefined && item.comments_count > 0}
                <span class="comments-count">
                  <img src="/icons/message-circle.svg" alt="Comments" class="icon-inline" />
                  {item.comments_count}
                </span>
              {/if}
            </div>
            {#if item.labels && item.labels.length > 0}
              <div class="item-labels">
                {#each item.labels.slice(0, 5) as label}
                  <span 
                    class="label-badge" 
                    style={label.color ? `background-color: #${label.color}20; color: #${label.color}; border-color: #${label.color}` : ''}
                  >
                    {label.name}
                  </span>
                {/each}
                {#if item.labels.length > 5}
                  <span class="more-labels">+{item.labels.length - 5} more</span>
                {/if}
              </div>
            {/if}
          </div>

          <div class="item-actions">
            <a 
              href={item.html_url} 
              target="_blank" 
              rel="noopener noreferrer"
              class="external-link"
            >
              View on {getPlatformName(item.platform)} →
            </a>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .dashboard-container {
    max-width: 1200px;
    margin: 0 auto;
    padding: 2rem;
  }

  .dashboard-header {
    margin-bottom: 2rem;
    padding-bottom: 1rem;
    border-bottom: 1px solid var(--border-color);
  }

  .dashboard-header h1 {
    margin: 0 0 0.5rem 0;
    color: var(--text-primary);
  }

  .dashboard-subtitle {
    color: var(--text-secondary);
    margin: 0 0 1rem 0;
  }

  .refresh-button {
    padding: 0.5rem 1rem;
    background: var(--button-primary);
    color: white;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.9rem;
    transition: background 0.2s;
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
  }

  .refresh-button:hover:not(:disabled) {
    background: var(--button-primary-hover);
  }

  .refresh-button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .tabs {
    display: flex;
    gap: 0.5rem;
    border-bottom: 1px solid var(--border-color);
    margin-bottom: 2rem;
  }

  .tab-button {
    padding: 0.75rem 1.5rem;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
    font-size: 1rem;
    color: var(--text-secondary);
    transition: all 0.2s;
  }

  .tab-button:hover {
    color: var(--text-primary);
    background: var(--bg-secondary);
  }

  .tab-button.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
    font-weight: 500;
  }

  .items-list {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .item-card {
    background: var(--card-bg);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 1.5rem;
    transition: box-shadow 0.2s, border-color 0.2s;
  }

  .item-card:hover {
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
    border-color: var(--accent);
  }

  .item-card.pr {
    border-left: 4px solid var(--accent);
  }

  .item-card.issue {
    border-left: 4px solid var(--success-color, #10b981);
  }

  .item-header {
    margin-bottom: 1rem;
  }

  .item-title-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 0.5rem;
  }

  .item-type-badge {
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    font-size: 0.75rem;
    font-weight: 600;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
  }

  .item-type-badge.pr {
    background: var(--accent-light);
    color: var(--accent);
  }

  .item-type-badge.issue {
    background: var(--success-bg, #d1fae5);
    color: var(--success-text, #065f46);
  }

  .item-title {
    font-size: 1.1rem;
    font-weight: 600;
    color: var(--text-primary);
    text-decoration: none;
    flex: 1;
  }

  .item-title:hover {
    color: var(--accent);
    text-decoration: underline;
  }

  .item-meta {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
    font-size: 0.85rem;
    color: var(--text-muted);
  }

  .platform-badge {
    padding: 0.25rem 0.5rem;
    background: var(--bg-secondary);
    border-radius: 4px;
    font-weight: 500;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
  }

  .repo-name {
    font-family: 'IBM Plex Mono', monospace;
    color: var(--text-secondary);
  }

  .item-number {
    color: var(--text-muted);
  }

  .item-body {
    margin-bottom: 1rem;
  }

  .item-description {
    color: var(--text-secondary);
    line-height: 1.6;
    margin: 0;
  }

  .item-footer {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding-top: 1rem;
    border-top: 1px solid var(--border-color);
  }

  .item-status {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .status-badge {
    padding: 0.25rem 0.75rem;
    border-radius: 4px;
    font-size: 0.85rem;
    font-weight: 600;
    text-transform: capitalize;
  }

  .status-badge.open {
    background: var(--success-bg);
    color: var(--success-text);
  }

  .status-badge.closed {
    background: var(--error-bg);
    color: var(--error-text);
  }

  .status-badge.merged {
    background: var(--accent-light);
    color: var(--accent);
  }

  .merged-indicator {
    color: var(--accent);
    font-size: 0.85rem;
  }

  .item-info {
    display: flex;
    align-items: center;
    gap: 1rem;
    font-size: 0.85rem;
    color: var(--text-muted);
  }

  .item-author {
    font-weight: 500;
  }

  .comments-count {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }

  .icon-inline {
    width: 14px;
    height: 14px;
    display: inline-block;
    vertical-align: middle;
  }

  .item-labels {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .label-badge {
    padding: 0.2rem 0.5rem;
    border-radius: 4px;
    font-size: 0.75rem;
    border: 1px solid var(--border-color);
    background: var(--bg-secondary);
    color: var(--text-primary);
  }

  .more-labels {
    font-size: 0.75rem;
    color: var(--text-muted);
    font-style: italic;
  }

  .item-actions {
    margin-top: 0.5rem;
  }

  .external-link {
    color: var(--accent);
    text-decoration: none;
    font-size: 0.9rem;
    font-weight: 500;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
  }

  .external-link:hover {
    text-decoration: underline;
  }

  .loading, .error, .empty-state {
    text-align: center;
    padding: 3rem 2rem;
    color: var(--text-muted);
  }

  .error {
    color: var(--error-text);
    background: var(--error-bg);
    border: 1px solid var(--error-text);
    border-radius: 8px;
    padding: 1.5rem;
  }

  .empty-state h2 {
    margin: 0 0 1rem 0;
    color: var(--text-primary);
  }

  .empty-state a {
    color: var(--accent);
    text-decoration: none;
  }

  .empty-state a:hover {
    text-decoration: underline;
  }
</style>
