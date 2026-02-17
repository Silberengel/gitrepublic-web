<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { NostrClient } from '../lib/services/nostr/nostr-client.js';
  import { KIND } from '../lib/types/nostr.js';
  import type { NostrEvent } from '../lib/types/nostr.js';
  import { nip19 } from 'nostr-tools';
  import { ForkCountService } from '../lib/services/nostr/fork-count-service.js';
  import { getPublicKeyWithNIP07, isNIP07Available } from '../lib/services/nostr/nip07-signer.js';

  let repos = $state<NostrEvent[]>([]);
  let allRepos = $state<NostrEvent[]>([]); // Store all repos for filtering
  let loading = $state(true);
  let error = $state<string | null>(null);
  let forkCounts = $state<Map<string, number>>(new Map());
  let searchQuery = $state('');
  let showOnlyMyContacts = $state(false);
  let userPubkey = $state<string | null>(null);
  let contactPubkeys = $state<Set<string>>(new Set());

  import { DEFAULT_NOSTR_RELAYS } from '../lib/config.js';
  const forkCountService = new ForkCountService(DEFAULT_NOSTR_RELAYS);

  const nostrClient = new NostrClient(DEFAULT_NOSTR_RELAYS);

  onMount(async () => {
    await loadRepos();
    await loadUserAndContacts();
  });

  async function loadUserAndContacts() {
    if (!isNIP07Available()) {
      return;
    }

    try {
      userPubkey = await getPublicKeyWithNIP07();
      contactPubkeys.add(userPubkey); // Include user's own repos

      // Fetch user's kind 3 contact list
      const contactEvents = await nostrClient.fetchEvents([
        {
          kinds: [KIND.CONTACT_LIST],
          authors: [userPubkey],
          limit: 1
        }
      ]);

      if (contactEvents.length > 0) {
        const contactEvent = contactEvents[0];
        // Extract pubkeys from 'p' tags
        for (const tag of contactEvent.tags) {
          if (tag[0] === 'p' && tag[1]) {
            let pubkey = tag[1];
            // Try to decode if it's an npub
            try {
              const decoded = nip19.decode(pubkey);
              if (decoded.type === 'npub') {
                pubkey = decoded.data as string;
              }
            } catch {
              // Assume it's already a hex pubkey
            }
            if (pubkey) {
              contactPubkeys.add(pubkey);
            }
          }
        }
      }
    } catch (err) {
      console.warn('Failed to load user or contacts:', err);
    }
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
      allRepos = [...repos]; // Store all repos for filtering

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

  interface SearchResult {
    repo: NostrEvent;
    score: number;
    matchType: string;
  }

  function performSearch() {
    if (!searchQuery.trim()) {
      repos = [...allRepos];
      return;
    }

    const query = searchQuery.trim().toLowerCase();
    const results: SearchResult[] = [];

    // Filter by contacts if enabled
    let reposToSearch = allRepos;
    if (showOnlyMyContacts && contactPubkeys.size > 0) {
      reposToSearch = allRepos.filter(event => {
        // Check if owner is in contacts
        if (contactPubkeys.has(event.pubkey)) return true;
        
        // Check if any maintainer is in contacts
        const maintainerTags = event.tags.filter(t => t[0] === 'maintainers');
        for (const tag of maintainerTags) {
          for (let i = 1; i < tag.length; i++) {
            let maintainerPubkey = tag[i];
            try {
              const decoded = nip19.decode(maintainerPubkey);
              if (decoded.type === 'npub') {
                maintainerPubkey = decoded.data as string;
              }
            } catch {
              // Assume it's already a hex pubkey
            }
            if (contactPubkeys.has(maintainerPubkey)) return true;
          }
        }
        return false;
      });
    }

    for (const repo of reposToSearch) {
      let score = 0;
      let matchType = '';

      // Extract repo fields
      const name = getRepoName(repo).toLowerCase();
      const dTag = repo.tags.find(t => t[0] === 'd')?.[1]?.toLowerCase() || '';
      const description = getRepoDescription(repo).toLowerCase();
      const cloneUrls = getCloneUrls(repo).map(url => url.toLowerCase());
      const maintainerTags = repo.tags.filter(t => t[0] === 'maintainers');
      const maintainers: string[] = [];
      for (const tag of maintainerTags) {
        for (let i = 1; i < tag.length; i++) {
          if (tag[i]) maintainers.push(tag[i].toLowerCase());
        }
      }

      // Try to decode query as hex id, naddr, or nevent
      let queryHex = '';
      try {
        const decoded = nip19.decode(query);
        if (decoded.type === 'naddr' || decoded.type === 'nevent') {
          queryHex = (decoded.data as any).id || '';
        }
      } catch {
        // Not a bech32 encoded value
      }

      // Check if query is a hex pubkey or npub
      let queryPubkey = '';
      try {
        const decoded = nip19.decode(query);
        if (decoded.type === 'npub') {
          queryPubkey = decoded.data as string;
        }
      } catch {
        // Check if it's a hex pubkey (64 hex chars)
        if (/^[0-9a-f]{64}$/i.test(query)) {
          queryPubkey = query;
        }
      }

      // Exact matches get highest score
      if (name === query) {
        score += 1000;
        matchType = 'exact-name';
      } else if (dTag === query) {
        score += 1000;
        matchType = 'exact-d-tag';
      } else if (repo.id.toLowerCase() === query || repo.id.toLowerCase() === queryHex) {
        score += 1000;
        matchType = 'exact-id';
      } else if (repo.pubkey.toLowerCase() === queryPubkey.toLowerCase()) {
        score += 800;
        matchType = 'exact-pubkey';
      }

      // Name matches
      if (name.includes(query)) {
        score += name.startsWith(query) ? 100 : 50;
        if (!matchType) matchType = 'name';
      }

      // D-tag matches
      if (dTag.includes(query)) {
        score += dTag.startsWith(query) ? 100 : 50;
        if (!matchType) matchType = 'd-tag';
      }

      // Description matches
      if (description.includes(query)) {
        score += 30;
        if (!matchType) matchType = 'description';
      }

      // Pubkey matches (owner)
      if (repo.pubkey.toLowerCase().includes(query.toLowerCase()) || 
          (queryPubkey && repo.pubkey.toLowerCase() === queryPubkey.toLowerCase())) {
        score += 200;
        if (!matchType) matchType = 'pubkey';
      }

      // Maintainer matches
      for (const maintainer of maintainers) {
        if (maintainer.includes(query.toLowerCase())) {
          score += 150;
          if (!matchType) matchType = 'maintainer';
          break;
        }
        // Check if maintainer is npub and matches query
        try {
          const decoded = nip19.decode(maintainer);
          if (decoded.type === 'npub') {
            const maintainerPubkey = decoded.data as string;
            if (maintainerPubkey.toLowerCase().includes(query.toLowerCase()) ||
                (queryPubkey && maintainerPubkey.toLowerCase() === queryPubkey.toLowerCase())) {
              score += 150;
              if (!matchType) matchType = 'maintainer';
              break;
            }
          }
        } catch {
          // Not an npub, already checked above
        }
      }

      // Clone URL matches
      for (const url of cloneUrls) {
        if (url.includes(query)) {
          score += 40;
          if (!matchType) matchType = 'clone-url';
          break;
        }
      }

      // Fulltext search in all tags and content
      const allText = [
        name,
        dTag,
        description,
        ...cloneUrls,
        ...maintainers,
        repo.content.toLowerCase()
      ].join(' ');

      if (allText.includes(query)) {
        score += 10;
        if (!matchType) matchType = 'fulltext';
      }

      if (score > 0) {
        results.push({ repo, score, matchType });
      }
    }

    // Sort by score (descending), then by created_at (descending)
    results.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return b.repo.created_at - a.repo.created_at;
    });

    repos = results.map(r => r.repo);
  }

  // Reactive search when query or filter changes
  $effect(() => {
    if (!loading) {
      performSearch();
    }
  });
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
  <main>
    <div class="repos-header">
      <h2>Repositories on {$page.data.gitDomain || 'localhost:6543'}</h2>
      <button onclick={loadRepos} disabled={loading}>
        {loading ? 'Loading...' : 'Refresh'}
      </button>
    </div>

    <div class="search-section">
      <div class="search-bar-container">
        <input
          type="text"
          bind:value={searchQuery}
          placeholder="Search by name, d-tag, pubkey, maintainers, clone URL, hex id/naddr/nevent, or fulltext..."
          class="search-input"
          disabled={loading}
          oninput={performSearch}
        />
      </div>
      {#if isNIP07Available() && userPubkey}
        <label class="filter-checkbox">
          <input
            type="checkbox"
            bind:checked={showOnlyMyContacts}
            onchange={performSearch}
          />
          <span>Show only my repos and those of my contacts</span>
        </label>
      {/if}
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

