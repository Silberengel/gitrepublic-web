<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { NostrClient } from '../lib/services/nostr/nostr-client.js';
  import { KIND } from '../lib/types/nostr.js';
  import type { NostrEvent } from '../lib/types/nostr.js';
  import { nip19 } from 'nostr-tools';

  let repos = $state<NostrEvent[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  import { DEFAULT_NOSTR_RELAYS } from '../lib/config.js';

  const nostrClient = new NostrClient(DEFAULT_NOSTR_RELAYS);

  onMount(async () => {
    await loadRepos();
  });

  async function loadRepos() {
    loading = true;
    error = null;
    
    try {
      const events = await nostrClient.fetchEvents([
        { kinds: [KIND.REPO_ANNOUNCEMENT], limit: 100 }
      ]);
      
      // Get git domain from layout data
      const gitDomain = $page.data.gitDomain || 'localhost:6543';
      
      // Filter for repos that list our domain in clone tags and are public
      repos = events.filter(event => {
        const cloneUrls = event.tags
          .filter(t => t[0] === 'clone')
          .flatMap(t => t.slice(1))
          .filter(url => url && typeof url === 'string');
        
        const hasDomain = cloneUrls.some(url => url.includes(gitDomain));
        if (!hasDomain) return false;

        // Filter out private repos from public listing
        const isPrivate = event.tags.some(t => 
          (t[0] === 'private' && t[1] === 'true') || 
          (t[0] === 't' && t[1] === 'private')
        );
        
        return !isPrivate; // Only show public repos
      });
      
      // Sort by created_at descending
      repos.sort((a, b) => b.created_at - a.created_at);
    } catch (e) {
      error = String(e);
      console.error('Failed to load repos:', e);
    } finally {
      loading = false;
    }
  }

  function getRepoName(event: NostrEvent): string {
    const nameTag = event.tags.find(t => t[0] === 'name' && t[1]);
    if (nameTag?.[1]) return nameTag[1];
    
    const dTag = event.tags.find(t => t[0] === 'd')?.[1];
    if (dTag) return dTag;
    
    return `Repository ${event.id.slice(0, 8)}`;
  }

  function getRepoDescription(event: NostrEvent): string {
    const descTag = event.tags.find(t => t[0] === 'description' && t[1]);
    return descTag?.[1] || '';
  }

  function getCloneUrls(event: NostrEvent): string[] {
    const urls: string[] = [];
    
    for (const tag of event.tags) {
      if (tag[0] === 'clone') {
        for (let i = 1; i < tag.length; i++) {
          const url = tag[i];
          if (url && typeof url === 'string') {
            urls.push(url);
          }
        }
      }
    }
    
    return urls;
  }

  function getNpubFromEvent(event: NostrEvent): string {
    // Extract npub from clone URLs that match our domain
    const gitDomain = $page.data.gitDomain || 'localhost:6543';
    const cloneUrls = getCloneUrls(event);
    
    for (const url of cloneUrls) {
      if (url.includes(gitDomain)) {
        // Extract npub from URL: https://domain/npub.../repo.git
        const match = url.match(/\/(npub[a-z0-9]+)\//);
        if (match) {
          return match[1];
        }
      }
    }
    
    // Fallback: convert pubkey to npub if needed
    try {
      if (event.pubkey.startsWith('npub')) {
        return event.pubkey;
      }
      return nip19.npubEncode(event.pubkey);
    } catch {
      // If conversion fails, return pubkey as-is
      return event.pubkey;
    }
  }

  function getRepoNameFromUrl(event: NostrEvent): string {
    const gitDomain = $page.data.gitDomain || 'localhost:6543';
    const cloneUrls = getCloneUrls(event);
    
    for (const url of cloneUrls) {
      if (url.includes(gitDomain)) {
        // Extract repo name from URL: https://domain/npub.../repo-name.git
        const match = url.match(/\/(npub[a-z0-9]+)\/([^\/]+)\.git/);
        if (match) {
          return match[2];
        }
      }
    }
    
    // Fallback to repo name from event
    return getRepoName(event);
  }
</script>

<div class="container">
  <header>
    <h1>gitrepublic</h1>
    <nav>
      <a href="/">Repositories</a>
      <a href="/signup">Sign Up</a>
      <a href="/docs/nip34">NIP-34 Docs</a>
    </nav>
  </header>

  <main>
    <div class="repos-header">
      <h2>Repositories on {$page.data.gitDomain || 'localhost:6543'}</h2>
      <button onclick={loadRepos} disabled={loading}>
        {loading ? 'Loading...' : 'Refresh'}
      </button>
    </div>

    {#if error}
      <div class="error">
        Error loading repositories: {error}
      </div>
    {:else if loading}
      <div class="loading">Loading repositories...</div>
    {:else if repos.length === 0}
      <div class="empty">No repositories found.</div>
    {:else}
      <div class="repos-list">
        {#each repos as repo}
          <div class="repo-card">
            <div class="repo-header">
              <h3>{getRepoName(repo)}</h3>
              <a href="/repos/{getNpubFromEvent(repo)}/{getRepoNameFromUrl(repo)}" class="view-button">
                View & Edit →
              </a>
            </div>
            {#if getRepoDescription(repo)}
              <p class="description">{getRepoDescription(repo)}</p>
            {/if}
            <div class="clone-urls">
              <strong>Clone URLs:</strong>
              {#each getCloneUrls(repo) as url}
                <code>{url}</code>
              {/each}
            </div>
            <div class="repo-meta">
              <span>Created: {new Date(repo.created_at * 1000).toLocaleDateString()}</span>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </main>
</div>

<style>
  .container {
    max-width: 1200px;
    margin: 0 auto;
    padding: 2rem;
  }

  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 2rem;
    border-bottom: 1px solid #e5e7eb;
    padding-bottom: 1rem;
  }

  nav {
    display: flex;
    gap: 1rem;
  }

  nav a {
    text-decoration: none;
    color: #3b82f6;
  }

  .repos-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 2rem;
  }

  .repos-list {
    display: grid;
    gap: 1.5rem;
  }

  .repo-card {
    border: 1px solid #e5e7eb;
    border-radius: 0.5rem;
    padding: 1.5rem;
    background: white;
  }

  .repo-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.5rem;
  }

  .repo-card h3 {
    margin: 0;
    font-size: 1.25rem;
  }

  .view-button {
    padding: 0.5rem 1rem;
    background: #3b82f6;
    color: white;
    text-decoration: none;
    border-radius: 0.25rem;
    font-size: 0.875rem;
    white-space: nowrap;
  }

  .view-button:hover {
    background: #2563eb;
  }

  .description {
    color: #6b7280;
    margin: 0.5rem 0;
  }

  .clone-urls {
    margin: 1rem 0;
  }

  .clone-urls code {
    display: block;
    background: #f3f4f6;
    padding: 0.5rem;
    border-radius: 0.25rem;
    margin: 0.25rem 0;
    font-family: monospace;
    font-size: 0.875rem;
  }

  .repo-meta {
    font-size: 0.875rem;
    color: #6b7280;
    margin-top: 1rem;
  }

  .error {
    background: #fee2e2;
    color: #991b1b;
    padding: 1rem;
    border-radius: 0.5rem;
    margin: 1rem 0;
  }

  .loading, .empty {
    text-align: center;
    padding: 2rem;
    color: #6b7280;
  }
</style>
