<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import UserBadge from '$lib/components/UserBadge.svelte';
  import { getPublicKeyWithNIP07, isNIP07Available } from '$lib/services/nostr/nip07-signer.js';
  import { nip19 } from 'nostr-tools';
  import { userStore } from '$lib/stores/user-store.js';

  let query = $state('');
  let searchType = $state<'repos' | 'code' | 'all'>('repos');
  let loading = $state(false);
  let userPubkeyHex = $state<string | null>(null);

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
    repos: Array<{ id: string; name: string; description: string; owner: string; npub: string }>;
    code: Array<{ repo: string; npub: string; file: string; matches: number }>;
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
      return;
    }

    loading = true;
    error = null;
    results = null; // Reset results

    try {
      const headers: Record<string, string> = {};
      if (userPubkeyHex) {
        headers['X-User-Pubkey'] = userPubkeyHex;
      }
      
      const response = await fetch(`/api/search?q=${encodeURIComponent(query)}&type=${searchType}`, {
        headers
      });
      if (response.ok) {
        const data = await response.json();
        // The API returns { query, type, results: { repos, code }, total }
        // Extract the nested results structure
        const apiResults = data.results || {};
        results = {
          repos: Array.isArray(apiResults.repos) ? apiResults.repos : [],
          code: Array.isArray(apiResults.code) ? apiResults.code : [],
          total: typeof data.total === 'number' ? data.total : (apiResults.repos?.length || 0) + (apiResults.code?.length || 0)
        };
      } else {
        const data = await response.json();
        error = data.error || 'Search failed';
        results = null; // Clear results on error
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Search failed';
      results = null; // Clear results on error
    } finally {
      loading = false;
    }
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
        placeholder="Search repositories or code... (NIP-50 search)"
        class="search-input"
      />
      <div class="search-controls">
        <select bind:value={searchType} class="search-type-select">
          <option value="repos">Repositories</option>
          <option value="code">Code</option>
          <option value="all">All</option>
        </select>
        <button type="submit" disabled={loading || !query.trim()} class="search-button">
          {loading ? 'Searching...' : 'Search'}
        </button>
      </div>
      <div class="search-info">
        <small>Using NIP-50 search across multiple relays for better results</small>
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

        {#if (searchType === 'repos' || searchType === 'all') && results.repos && results.repos.length > 0}
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
                    <a href={`/users/${repo.npub}`} onclick={(e) => e.stopPropagation()}>
                      <UserBadge pubkey={repo.owner} />
                    </a>
                  </div>
                </div>
              {/each}
            </div>
          </section>
        {/if}

        {#if (searchType === 'code' || searchType === 'all') && results.code && results.code.length > 0}
          <section class="results-section">
            <h3>Code Files ({results.code.length})</h3>
            <div class="code-list">
              {#each results.code as file}
                <div 
                  class="code-item" 
                  role="button"
                  tabindex="0"
                  onclick={() => goto(`/repos/${file.npub}/${file.repo}?file=${encodeURIComponent(file.file)}`)}
                  onkeydown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      goto(`/repos/${file.npub}/${file.repo}?file=${encodeURIComponent(file.file)}`);
                    }
                  }}
                  style="cursor: pointer;">
                  <div class="code-file-path">{file.file}</div>
                  <div class="code-repo">
                    <a href={`/repos/${file.npub}/${file.repo}`} onclick={(e) => e.stopPropagation()}>
                      {file.repo}
                    </a>
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
</style>
