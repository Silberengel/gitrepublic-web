<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { NostrClient } from '../lib/services/nostr/nostr-client.js';
  import { KIND } from '../lib/types/nostr.js';
  import type { NostrEvent } from '../lib/types/nostr.js';
  import { nip19 } from 'nostr-tools';
  import { getPublicKeyWithNIP07, isNIP07Available } from '../lib/services/nostr/nip07-signer.js';
  import { ForkCountService } from '../lib/services/nostr/fork-count-service.js';
  import ThemeToggle from '../lib/components/ThemeToggle.svelte';

  let repos = $state<NostrEvent[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let userPubkey = $state<string | null>(null);
  let forkCounts = $state<Map<string, number>>(new Map());

  import { DEFAULT_NOSTR_RELAYS } from '../lib/config.js';
  const forkCountService = new ForkCountService(DEFAULT_NOSTR_RELAYS);

  const nostrClient = new NostrClient(DEFAULT_NOSTR_RELAYS);

  onMount(async () => {
    await loadRepos();
    await checkAuth();
  });

  async function checkAuth() {
    try {
      if (isNIP07Available()) {
        userPubkey = await getPublicKeyWithNIP07();
      }
    } catch (err) {
      console.log('NIP-07 not available or user not connected');
      userPubkey = null;
    }
  }

  async function login() {
    try {
      if (!isNIP07Available()) {
        alert('NIP-07 extension not found. Please install a Nostr extension like Alby or nos2x.');
        return;
      }
      userPubkey = await getPublicKeyWithNIP07();
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to connect';
      console.error('Login error:', err);
    }
  }

  function logout() {
    userPubkey = null;
  }

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

      // Load fork counts for all repos (in parallel, but don't block)
      loadForkCounts(repos).catch(err => {
        console.warn('[RepoList] Failed to load some fork counts:', err);
      });
    } catch (e) {
      error = String(e);
      console.error('[RepoList] Failed to load repos:', e);
    } finally {
      loading = false;
    }
  }

  async function loadForkCounts(repoEvents: NostrEvent[]) {
    const counts = new Map<string, number>();
    
    // Extract owner pubkey and repo name for each repo
    const forkCountPromises = repoEvents.map(async (event) => {
      try {
        const dTag = event.tags.find(t => t[0] === 'd')?.[1];
        if (!dTag) return;
        
        const repoKey = `${event.pubkey}:${dTag}`;
        const count = await forkCountService.getForkCount(event.pubkey, dTag);
        counts.set(repoKey, count);
      } catch (err) {
        // Ignore individual failures
      }
    });

    await Promise.all(forkCountPromises);
    forkCounts = counts;
  }

  function getForkCount(event: NostrEvent): number {
    const dTag = event.tags.find(t => t[0] === 'd')?.[1];
    if (!dTag) return 0;
    const repoKey = `${event.pubkey}:${dTag}`;
    return forkCounts.get(repoKey) || 0;
  }

  function goToSearch() {
    goto('/search');
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

  function getRepoImage(event: NostrEvent): string | null {
    const imageTag = event.tags.find(t => t[0] === 'image' && t[1]);
    return imageTag?.[1] || null;
  }

  function getRepoBanner(event: NostrEvent): string | null {
    const bannerTag = event.tags.find(t => t[0] === 'banner' && t[1]);
    return bannerTag?.[1] || null;
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

  // Get page data for OpenGraph metadata
  const pageData = $page.data as {
    title?: string;
    description?: string;
    image?: string;
    url?: string;
    ogType?: string;
  };
</script>

<svelte:head>
  <title>{pageData.title || 'GitRepublic - Decentralized Git Hosting on Nostr'}</title>
  <meta name="description" content={pageData.description || 'A decentralized git hosting platform built on Nostr. Host your repositories, collaborate with others, and maintain full control of your code.'} />
  
  <!-- OpenGraph / Facebook -->
  <meta property="og:type" content={pageData.ogType || 'website'} />
  <meta property="og:title" content={pageData.title || 'GitRepublic - Decentralized Git Hosting on Nostr'} />
  <meta property="og:description" content={pageData.description || 'A decentralized git hosting platform built on Nostr. Host your repositories, collaborate with others, and maintain full control of your code.'} />
  <meta property="og:url" content={pageData.url || `https://${$page.url.host}${$page.url.pathname}`} />
  {#if pageData.image}
    <meta property="og:image" content={pageData.image} />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
  {/if}
  
  <!-- Twitter Card -->
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content={pageData.title || 'GitRepublic - Decentralized Git Hosting on Nostr'} />
  <meta name="twitter:description" content={pageData.description || 'A decentralized git hosting platform built on Nostr. Host your repositories, collaborate with others, and maintain full control of your code.'} />
  {#if pageData.image}
    <meta name="twitter:image" content={pageData.image} />
  {/if}
</svelte:head>

<div class="container">
  <header>
    <h1>gitrepublic</h1>
    <nav>
      <a href="/">Repositories</a>
      <a href="/search">Search</a>
      <a href="/signup">Sign Up</a>
      <a href="/docs/nip34">NIP-34 Docs</a>
      <div class="auth-section">
        <ThemeToggle />
        {#if userPubkey}
          <span class="user-info">
            {nip19.npubEncode(userPubkey).slice(0, 16)}...
          </span>
          <button onclick={logout} class="logout-button">Logout</button>
        {:else}
          <button onclick={login} class="login-button" disabled={!isNIP07Available()}>
            {isNIP07Available() ? 'Login' : 'NIP-07 Not Available'}
          </button>
        {/if}
      </div>
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
          {@const repoImage = getRepoImage(repo)}
          {@const repoBanner = getRepoBanner(repo)}
          <div class="repo-card">
            {#if repoBanner}
              <div class="repo-card-banner">
                <img src={repoBanner} alt="Banner" />
              </div>
            {/if}
            <div class="repo-card-content">
              <div class="repo-header">
                {#if repoImage}
                  <img src={repoImage} alt="Repository" class="repo-card-image" />
                {/if}
                <div class="repo-header-text">
                  <h3>{getRepoName(repo)}</h3>
                  {#if getRepoDescription(repo)}
                    <p class="description">{getRepoDescription(repo)}</p>
                  {/if}
                </div>
                <a href="/repos/{getNpubFromEvent(repo)}/{getRepoNameFromUrl(repo)}" class="view-button">
                  View & Edit →
                </a>
              </div>
              <div class="clone-urls">
                <strong>Clone URLs:</strong>
                {#each getCloneUrls(repo) as url}
                  <code>{url}</code>
                {/each}
              </div>
              <div class="repo-meta">
                <span>Created: {new Date(repo.created_at * 1000).toLocaleDateString()}</span>
                {#if getForkCount(repo) > 0}
                  {@const forkCount = getForkCount(repo)}
                  <span class="fork-count">🍴 {forkCount} fork{forkCount === 1 ? '' : 's'}</span>
                {/if}
              </div>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </main>
</div>

