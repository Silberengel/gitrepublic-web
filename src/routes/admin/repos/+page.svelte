<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { userStore } from '$lib/stores/user-store.js';
  import type { NostrEvent } from '$lib/types/nostr.js';

  interface AdminRepo {
    npub: string;
    repoName: string;
    fullPath: string;
    size: number;
    lastModified: number;
    createdAt: number;
    announcement?: NostrEvent | null;
  }

  let repos = $state<AdminRepo[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let deleting = $state<Set<string>>(new Set());
  let totalSize = $state(0);

  // Check if user has admin access via API
  let accessChecked = $state(false);
  let hasAccess = $state(false);
  
  async function checkAdminAccess() {
    if (typeof window === 'undefined') return;
    
    const user = $userStore;
    if (!user || !user.userPubkeyHex) {
      hasAccess = false;
      accessChecked = true;
      // Redirect to repos page (not splash) if not logged in
      setTimeout(() => {
        goto('/repos');
      }, 100);
      return;
    }
    
    try {
      const response = await fetch('/api/admin/check', {
        headers: {
          'X-User-Pubkey': user.userPubkeyHex
        }
      });
      
      if (response.ok) {
        const data = await response.json();
        hasAccess = data.isAdmin === true;
        console.log('[Admin] Admin check result:', data.isAdmin, 'for user:', user.userPubkeyHex.substring(0, 16) + '...');
      } else {
        hasAccess = false;
        console.warn('[Admin] Admin check failed:', response.status);
      }
    } catch (err) {
      console.warn('[Admin] Failed to check admin status:', err);
      hasAccess = false;
    } finally {
      accessChecked = true;
      
      // Redirect to repos page (not splash) if user doesn't have admin access
      // But only if they're logged in - if not logged in, already redirected above
      if (!hasAccess && user && user.userPubkeyHex) {
        setTimeout(() => {
          goto('/repos');
        }, 100);
      }
    }
  }
  
  // Check admin access and load repos on mount
  onMount(() => {
    checkAdminAccess().then(() => {
      // Only load repos if user has access
      if (hasAccess) {
        loadRepos();
      }
    });
  });

  async function loadRepos() {
    loading = true;
    error = null;
    
    try {
      const user = $userStore;
      if (!user?.userPubkeyHex) {
        throw new Error('Not authenticated');
      }
      
      const response = await fetch('/api/admin/repos', {
        headers: {
          'X-User-Pubkey': user.userPubkeyHex
        }
      });
      
      if (!response.ok) {
        const data = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(data.error || `Failed to load repositories: ${response.statusText}`);
      }
      
      const data = await response.json();
      repos = data.repos || [];
      totalSize = data.totalSize || 0;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load repositories';
      console.error('[Admin] Failed to load repos:', e);
    } finally {
      loading = false;
    }
  }

  async function deleteRepo(npub: string, repoName: string) {
    const repoKey = `${npub}/${repoName}`;
    
    if (!confirm(`Are you sure you want to delete ${repoName}? This action cannot be undone.`)) {
      return;
    }
    
    deleting.add(repoKey);
    error = null;
    
    try {
      const user = $userStore;
      if (!user?.userPubkeyHex) {
        throw new Error('Not authenticated');
      }
      
      const response = await fetch(`/api/repos/${npub}/${repoName}/delete`, {
        method: 'DELETE',
        headers: {
          'X-User-Pubkey': user.userPubkeyHex
        }
      });
      
      if (!response.ok) {
        const data = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(data.error || `Failed to delete repository: ${response.statusText}`);
      }
      
      // Remove from list
      repos = repos.filter(r => !(r.npub === npub && r.repoName === repoName));
      totalSize = repos.reduce((sum, repo) => sum + repo.size, 0);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to delete repository';
      console.error('[Admin] Failed to delete repo:', e);
      alert(error);
    } finally {
      deleting.delete(repoKey);
    }
  }

  function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  }

  function formatDate(timestamp: number): string {
    return new Date(timestamp).toLocaleString();
  }

  // Helper function to navigate to a repo with announcement in sessionStorage
  async function navigateToRepo(npub: string, repoName: string, announcement?: NostrEvent | null) {
    // If we have the announcement, store it in sessionStorage
    if (announcement && typeof window !== 'undefined') {
      const repoKey = `${npub}/${repoName}`;
      try {
        sessionStorage.setItem(`repo_announcement_${repoKey}`, JSON.stringify(announcement));
        console.log(`[Admin] Stored announcement in sessionStorage for ${repoKey}`);
      } catch (err) {
        console.warn('[Admin] Failed to store announcement in sessionStorage:', err);
      }
    } else {
      // Try to fetch announcement from API
      try {
        const response = await fetch(`/api/repos/local?domain=${encodeURIComponent(window.location.hostname)}`);
        if (response.ok) {
          const data = await response.json();
          const repo = data.find((r: { npub: string; repoName: string; announcement: NostrEvent | null }) => 
            r.npub === npub && r.repoName === repoName
          );
          if (repo?.announcement) {
            const repoKey = `${npub}/${repoName}`;
            sessionStorage.setItem(`repo_announcement_${repoKey}`, JSON.stringify(repo.announcement));
            console.log(`[Admin] Fetched and stored announcement from API for ${repoKey}`);
          }
        }
      } catch (err) {
        console.warn('[Admin] Failed to fetch announcement from API:', err);
      }
    }
    goto(`/repos/${npub}/${repoName}`);
  }
</script>

<svelte:head>
  <title>Admin - Repositories</title>
</svelte:head>

<div class="admin-page">
  <div class="admin-header">
    <h1>Repository Administration</h1>
    <button onclick={loadRepos} disabled={loading} class="refresh-button">
      {loading ? 'Loading...' : 'Refresh'}
    </button>
  </div>

  {#if !accessChecked}
    <div class="loading">Checking access...</div>
  {:else if !hasAccess}
    <div class="error-message">Access denied. Admin privileges required.</div>
  {:else}
    {#if error}
      <div class="error-message">
        {error}
      </div>
    {/if}

    {#if loading}
      <div class="loading">Loading repositories...</div>
    {:else}
      <div class="stats">
      <div class="stat">
        <span class="stat-label">Total Repositories:</span>
        <span class="stat-value">{repos.length}</span>
      </div>
      <div class="stat">
        <span class="stat-label">Total Size:</span>
        <span class="stat-value">{formatBytes(totalSize)}</span>
      </div>
    </div>

    <div class="repos-table-container">
      <table class="repos-table">
        <thead>
          <tr>
            <th>Owner (npub)</th>
            <th>Repository Name</th>
            <th>Size</th>
            <th>Last Modified</th>
            <th>Created</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {#each repos as repo (repo.npub + repo.repoName)}
            <tr>
              <td class="npub-cell">
                <code>{repo.npub.substring(0, 20)}...</code>
              </td>
              <td class="repo-name-cell">
                <button 
                  onclick={() => navigateToRepo(repo.npub, repo.repoName, repo.announcement)}
                  class="repo-link-button"
                  title="View repository"
                >
                  {repo.repoName}
                </button>
              </td>
              <td>{formatBytes(repo.size)}</td>
              <td>{formatDate(repo.lastModified)}</td>
              <td>{formatDate(repo.createdAt)}</td>
              <td class="actions-cell">
                <button
                  onclick={() => deleteRepo(repo.npub, repo.repoName)}
                  disabled={deleting.has(`${repo.npub}/${repo.repoName}`)}
                  class="delete-button"
                  title="Delete repository"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                    <line x1="10" y1="11" x2="10" y2="17"/>
                    <line x1="14" y1="11" x2="14" y2="17"/>
                  </svg>
                </button>
              </td>
            </tr>
          {:else}
            <tr>
              <td colspan="6" class="empty-message">No repositories found</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    {/if}
  {/if}
</div>

<style>
  .admin-page {
    max-width: 1400px;
    margin: 0 auto;
    padding: 2rem;
  }

  .admin-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 2rem;
  }

  .admin-header h1 {
    margin: 0;
    font-size: 2rem;
  }

  .refresh-button {
    padding: 0.5rem 1rem;
    background: var(--button-primary);
    color: var(--accent-text, #ffffff);
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.9rem;
    font-family: 'IBM Plex Serif', serif;
    transition: background 0.2s ease;
  }

  .refresh-button:hover:not(:disabled) {
    background: var(--button-primary-hover);
  }

  .refresh-button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .error-message {
    background: var(--error-bg);
    color: var(--error-text);
    padding: 1rem;
    border-radius: 4px;
    margin-bottom: 1rem;
    border: 1px solid var(--error-text);
  }

  .loading {
    text-align: center;
    padding: 2rem;
    color: var(--text-muted);
  }

  .stats {
    display: flex;
    gap: 2rem;
    margin-bottom: 2rem;
    padding: 1rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 4px;
  }

  .stat {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .stat-label {
    font-size: 0.875rem;
    color: var(--text-muted);
  }

  .stat-value {
    font-size: 1.25rem;
    font-weight: bold;
    color: var(--text-primary);
  }

  .repos-table-container {
    overflow-x: auto;
    background: var(--card-bg);
    border: 1px solid var(--border-color);
    border-radius: 4px;
    box-shadow: 0 2px 4px var(--shadow-color-light);
  }

  .repos-table {
    width: 100%;
    border-collapse: collapse;
  }

  .repos-table thead {
    background: var(--bg-secondary);
  }

  .repos-table th {
    padding: 1rem;
    text-align: left;
    font-weight: 600;
    border-bottom: 2px solid var(--border-color);
    color: var(--text-primary);
  }

  .repos-table td {
    padding: 1rem;
    border-bottom: 1px solid var(--border-light);
    color: var(--text-primary);
  }

  .repos-table tbody tr:hover {
    background: var(--bg-tertiary);
  }

  .npub-cell code {
    font-size: 0.875rem;
    color: var(--text-secondary);
    background: var(--bg-secondary);
    padding: 0.25rem 0.5rem;
    border-radius: 3px;
    border: 1px solid var(--border-color);
  }

  .repo-link-button {
    background: none;
    border: none;
    color: var(--link-color);
    text-decoration: none;
    font-weight: 500;
    cursor: pointer;
    padding: 0;
    font-size: inherit;
    font-family: inherit;
  }

  .repo-link-button:hover {
    color: var(--link-hover);
    text-decoration: underline;
  }

  .actions-cell {
    text-align: center;
  }

  .delete-button {
    background: transparent;
    border: none;
    color: var(--error-text);
    cursor: pointer;
    padding: 0.5rem;
    border-radius: 4px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: background 0.2s;
  }

  .delete-button:hover:not(:disabled) {
    background: var(--error-bg);
  }

  .delete-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .empty-message {
    text-align: center;
    padding: 2rem;
    color: var(--text-muted);
  }
</style>
