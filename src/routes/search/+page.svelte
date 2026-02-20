<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import UserBadge from '$lib/components/UserBadge.svelte';
  import { getPublicKeyWithNIP07, isNIP07Available } from '$lib/services/nostr/nip07-signer.js';
  import { nip19 } from 'nostr-tools';
  import { userStore } from '$lib/stores/user-store.js';

  let query = $state('');
  let loading = $state(false);
  let userPubkeyHex = $state<string | null>(null);
  let searchAbortController: AbortController | null = null;

  // Sync with userStore
  $effect(() => {
    const currentUser = $userStore;
    const wasLoggedIn = userPubkeyHex !== null;
    
    if (currentUser.userPubkeyHex) {
      const wasDifferent = userPubkeyHex !== currentUser.userPubkeyHex;
      userPubkeyHex = currentUser.userPubkeyHex;
      
      // If user just logged in and we have search results, reload to show private repos
      if (wasDifferent && results && query.trim()) {
        performSearch().catch(err => console.warn('Failed to reload search after login:', err));
      }
    } else {
      userPubkeyHex = null;
      
      // If user just logged out and we have search results, reload to hide private repos
      if (wasLoggedIn && results && query.trim()) {
        performSearch().catch(err => console.warn('Failed to reload search after logout:', err));
      }
    }
  });
  let results = $state<{
    repos: Array<{ 
      id: string; 
      name: string; 
      description: string; 
      owner: string; 
      npub: string;
      maintainers?: Array<{ pubkey: string; isOwner: boolean }>;
    }>;
    total: number;
  } | null>(null);
  let error = $state<string | null>(null);

  onMount(async () => {
    await loadUserPubkey();
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
      const userPubkey = await getPublicKeyWithNIP07();
      // Convert npub to hex for API calls
      try {
        const decoded = nip19.decode(userPubkey);
        if (decoded.type === 'npub') {
          userPubkeyHex = decoded.data as string;
        }
      } catch {
        userPubkeyHex = userPubkey; // Assume it's already hex
      }
    } catch (err) {
      console.warn('Failed to load user pubkey:', err);
    }
  }

  async function performSearch() {
    if (!query.trim() || query.length < 2) {
      results = null;
      return;
    }

    // Cancel any ongoing search
    if (searchAbortController) {
      searchAbortController.abort();
    }

    // Create new abort controller for this search
    searchAbortController = new AbortController();
    const currentAbortController = searchAbortController;

    loading = true;
    error = null;
    results = null; // Reset results

    try {
      const headers: Record<string, string> = {};
      if (userPubkeyHex) {
        headers['X-User-Pubkey'] = userPubkeyHex;
      }
      
      const response = await fetch(`/api/search?q=${encodeURIComponent(query.trim())}`, {
        headers,
        signal: currentAbortController.signal
      });
      
      // Check if request was aborted
      if (currentAbortController.signal.aborted) {
        return;
      }
      
      if (response.ok) {
        const data = await response.json();
        // Verify the response matches our current query (in case of race conditions)
        if (data.query !== query.trim()) {
          // Response is for a different query, ignore it
          return;
        }
        
        // The API returns { query, results: { repos }, total }
        // Extract the nested results structure
        const apiResults = data.results || {};
        results = {
          repos: Array.isArray(apiResults.repos) ? apiResults.repos : [],
          total: typeof data.total === 'number' ? data.total : (apiResults.repos?.length || 0)
        };
      } else {
        const data = await response.json();
        error = data.error || 'Search failed';
        results = null; // Clear results on error
      }
    } catch (err) {
      // Ignore abort errors
      if (err instanceof Error && err.name === 'AbortError') {
        return;
      }
      error = err instanceof Error ? err.message : 'Search failed';
      results = null; // Clear results on error
    } finally {
      // Only update loading state if this is still the current search
      if (currentAbortController === searchAbortController) {
        loading = false;
      }
    }
  }

  function cancelSearch() {
    if (searchAbortController) {
      searchAbortController.abort();
      searchAbortController = null;
    }
    loading = false;
    results = null;
    error = null;
  }

  function clearSearch() {
    query = '';
    cancelSearch();
  }

  function handleSearch(e: Event) {
    e.preventDefault();
    performSearch();
  }
</script>

<div class="container">
  <header>
    <h1>Search</h1>
  </header>

  <main>
    <form onsubmit={handleSearch} class="search-form">
      <input
        type="text"
        bind:value={query}
        placeholder="Search repositories by name, description, pubkey (hex/npub/nprofile/NIP-05), or clone URL..."
        class="search-input"
      />
      <div class="search-controls">
        <button type="submit" disabled={loading || !query.trim()} class="search-button">
          {loading ? 'Searching...' : 'Search'}
        </button>
        {#if loading || results || query.trim()}
          <button type="button" onclick={clearSearch} class="cancel-button">
            Cancel
          </button>
        {/if}
      </div>
      <div class="search-info">
        <small>Search repositories by name, description, pubkey (hex/npub/nprofile/NIP-05), or clone URL.</small>
      </div>
    </form>

    {#if error}
      <div class="error">{error}</div>
    {/if}

    {#if results}
      <div class="results">
        <div class="results-header">
          <h2>Results ({results.total || 0})</h2>
        </div>

        {#if results.repos && results.repos.length > 0}
          <section class="results-section">
            <h3>Repositories ({results.repos.length})</h3>
            <div class="repo-list">
              {#each results.repos as repo}
                <div 
                  class="repo-item" 
                  role="button"
                  tabindex="0"
                  onclick={() => goto(`/repos/${repo.npub}/${repo.name.toLowerCase().replace(/\s+/g, '-')}`)}
                  onkeydown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      goto(`/repos/${repo.npub}/${repo.name.toLowerCase().replace(/\s+/g, '-')}`);
                    }
                  }}
                  style="cursor: pointer;">
                  <h4>{repo.name}</h4>
                  {#if repo.description}
                    <p class="repo-description">{repo.description}</p>
                  {/if}
                  <div class="repo-meta">
                    {#if repo.maintainers && repo.maintainers.length > 0}
                      <div class="repo-contributors">
                        <span class="contributors-label">Owners & Maintainers:</span>
                        <div class="contributors-list">
                          {#each repo.maintainers as maintainer}
                            {@const maintainerNpub = nip19.npubEncode(maintainer.pubkey)}
                            <a 
                              href={`/users/${maintainerNpub}`} 
                              class="contributor-item"
                              class:contributor-owner={maintainer.isOwner}
                              onclick={(e) => e.stopPropagation()}
                            >
                              <UserBadge pubkey={maintainer.pubkey} />
                              {#if maintainer.isOwner}
                                <span class="contributor-badge owner">Owner</span>
                              {:else}
                                <span class="contributor-badge maintainer">Maintainer</span>
                              {/if}
                            </a>
                          {/each}
                        </div>
                      </div>
                    {:else}
                      <!-- Fallback: show owner if maintainers not available -->
                      <a href={`/users/${repo.npub}`} onclick={(e) => e.stopPropagation()}>
                        <UserBadge pubkey={repo.owner} />
                      </a>
                    {/if}
                  </div>
                </div>
              {/each}
            </div>
          </section>
        {/if}

        {#if results.total === 0}
          <div class="no-results">No results found</div>
        {/if}
      </div>
    {/if}
  </main>
</div>

<style>
  .search-info {
    margin-top: 0.5rem;
    color: var(--text-secondary, #666);
    font-size: 0.875rem;
  }

  .search-info small {
    color: inherit;
  }

  .search-controls {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    flex-wrap: wrap;
  }

  .cancel-button {
    padding: 0.5rem 1rem;
    background: var(--bg-secondary, #e8e8e8);
    color: var(--text-primary, #1a1a1a);
    border: 1px solid var(--border-color, #ccc);
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.875rem;
    transition: background-color 0.2s;
  }

  .cancel-button:hover {
    background: var(--bg-tertiary, #d0d0d0);
  }

  .cancel-button:active {
    background: var(--bg-quaternary, #b8b8b8);
  }

  .repo-contributors {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }

  .contributors-label {
    font-size: 0.875rem;
    color: var(--text-muted, #666);
    font-weight: 500;
  }

  .contributors-list {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }

  .contributor-item {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    text-decoration: none;
    padding: 0.25rem 0.5rem;
    border-radius: 0.5rem;
    background: var(--bg-secondary, #f0f0f0);
    border: 1px solid var(--border-color, #ddd);
    transition: all 0.2s ease;
  }

  .contributor-item:hover {
    border-color: var(--accent, #8a2be2);
    background: var(--card-bg, #fff);
  }

  .contributor-item.contributor-owner {
    background: var(--accent-light, var(--bg-tertiary));
    border: 2px solid var(--accent, var(--border-color));
    font-weight: 600;
    box-shadow: 0 0 0 1px var(--accent-light, transparent);
  }

  .contributor-item.contributor-owner:hover {
    background: var(--accent-light, var(--bg-tertiary));
    border-color: var(--accent, var(--border-color));
    box-shadow: 0 0 0 2px var(--accent-light, transparent);
  }

  .contributor-badge {
    padding: 0.25rem 0.5rem;
    border-radius: 0.25rem;
    font-size: 0.7rem;
    font-weight: 700;
    text-transform: uppercase;
    white-space: nowrap;
    letter-spacing: 0.05em;
    border: 1px solid transparent;
    min-height: 1.5rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .contributor-badge.owner {
    background: var(--bg-tertiary);
    color: var(--text-primary);
    border-color: var(--border-color);
  }

  .contributor-badge.maintainer {
    background: var(--success-bg);
    color: var(--success-text);
    border-color: var(--border-color);
  }
</style>
