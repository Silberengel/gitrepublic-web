<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';

  let query = $state('');
  let searchType = $state<'repos' | 'code' | 'all'>('repos');
  let loading = $state(false);
  let results = $state<{
    repos: Array<{ id: string; name: string; description: string; owner: string; npub: string }>;
    code: Array<{ repo: string; npub: string; file: string; matches: number }>;
    total: number;
  } | null>(null);
  let error = $state<string | null>(null);

  async function performSearch() {
    if (!query.trim() || query.length < 2) {
      return;
    }

    loading = true;
    error = null;

    try {
      const response = await fetch(`/api/search?q=${encodeURIComponent(query)}&type=${searchType}`);
      if (response.ok) {
        results = await response.json();
      } else {
        const data = await response.json();
        error = data.error || 'Search failed';
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Search failed';
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
        placeholder="Search repositories or code..."
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
    </form>

    {#if error}
      <div class="error">{error}</div>
    {/if}

    {#if results}
      <div class="results">
        <div class="results-header">
          <h2>Results ({results.total})</h2>
        </div>

        {#if (searchType === 'repos' || searchType === 'all') && results.repos.length > 0}
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
                      {repo.npub.slice(0, 16)}...
                    </a>
                  </div>
                </div>
              {/each}
            </div>
          </section>
        {/if}

        {#if (searchType === 'code' || searchType === 'all') && results.code.length > 0}
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

