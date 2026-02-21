<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { NostrClient } from '$lib/services/nostr/nostr-client.js';
  import { KIND } from '$lib/types/nostr.js';
  import type { NostrEvent } from '$lib/types/nostr.js';
  import { nip19 } from 'nostr-tools';
  import { ForkCountService } from '$lib/services/nostr/fork-count-service.js';
  import { getPublicKeyWithNIP07, isNIP07Available } from '$lib/services/nostr/nip07-signer.js';
  import { userStore } from '$lib/stores/user-store.js';
  import { hasUnlimitedAccess } from '$lib/utils/user-access.js';

  // Registered repos (with domain in clone URLs)
  let registeredRepos = $state<Array<{ event: NostrEvent; npub: string; repoName: string }>>([]);
  let allRegisteredRepos = $state<Array<{ event: NostrEvent; npub: string; repoName: string }>>([]);
  
  // Local clones (repos without domain in clone URLs)
  let localRepos = $state<Array<{ npub: string; repoName: string; announcement: NostrEvent | null; lastModified: number }>>([]);
  let allLocalRepos = $state<Array<{ npub: string; repoName: string; announcement: NostrEvent | null; lastModified: number }>>([]);
  
  let loading = $state(true);
  let loadingLocal = $state(false);
  let error = $state<string | null>(null);
  let forkCounts = $state<Map<string, number>>(new Map());
  let userPubkey = $state<string | null>(null);
  let userPubkeyHex = $state<string | null>(null);
  let contactPubkeys = $state<Set<string>>(new Set());
  let deletingRepo = $state<{ npub: string; repo: string } | null>(null);
  
  // User's own repositories (where they are owner or maintainer)
  // Also includes repos they transferred away (marked as transferred)
  let myRepos = $state<Array<{ event: NostrEvent; npub: string; repoName: string; transferred?: boolean; currentOwner?: string }>>([]);
  let loadingMyRepos = $state(false);

  // Most Favorited Repositories
  let mostFavoritedRepos = $state<Array<{ event: NostrEvent; npub: string; repoName: string; favoriteCount: number }>>([]);
  let loadingMostFavorited = $state(false);
  let mostFavoritedPage = $state(0);
  let mostFavoritedCache: { data: typeof mostFavoritedRepos; timestamp: number } | null = null;
  const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  import { DEFAULT_NOSTR_RELAYS } from '$lib/config.js';
  const forkCountService = new ForkCountService(DEFAULT_NOSTR_RELAYS);

  const nostrClient = new NostrClient(DEFAULT_NOSTR_RELAYS);

  onMount(async () => {
    await loadRepos();
    await loadUserAndContacts();
    await loadMyRepos();
    await loadMostFavoritedRepos();
  });

  // Reload repos when page becomes visible (e.g., after returning from another page)
  $effect(() => {
    if (typeof document !== 'undefined') {
      const handleVisibilityChange = () => {
        if (document.visibilityState === 'visible') {
          // Reload repos when page becomes visible to catch newly published repos
          loadRepos().catch(err => console.warn('Failed to reload repos on visibility change:', err));
          loadMyRepos().catch(err => console.warn('Failed to reload my repos on visibility change:', err));
        }
      };
      document.addEventListener('visibilitychange', handleVisibilityChange);
      return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
    }
  });

  // Reload my repos when navigating to repos page (e.g., after transfer)
  $effect(() => {
    if ($page.url.pathname === '/repos' && userPubkeyHex) {
      loadMyRepos().catch(err => console.warn('Failed to reload my repos on page navigation:', err));
    }
  });

  // Sync with userStore - if userStore says logged out, clear local state
  $effect(() => {
    const currentUser = $userStore;
    if (!currentUser.userPubkey || !currentUser.userPubkeyHex) {
      // User is logged out according to store - clear local state
      const wasLoggedIn = userPubkey !== null || userPubkeyHex !== null;
      userPubkey = null;
      userPubkeyHex = null;
      myRepos = [];
      contactPubkeys.clear();
      
      // If user was logged in before, reload repos to hide private ones
      if (wasLoggedIn) {
        loadRepos().catch(err => console.warn('Failed to reload repos after logout:', err));
        loadLocalRepos().catch(err => console.warn('Failed to reload local repos after logout:', err));
      }
    } else if (currentUser.userPubkey && currentUser.userPubkeyHex) {
      // User is logged in according to store - sync local state
      // Only update if different to avoid unnecessary reloads
      const wasDifferent = userPubkey !== currentUser.userPubkey || userPubkeyHex !== currentUser.userPubkeyHex;
      const wasLoggedOut = userPubkey === null && userPubkeyHex === null;
      
      if (wasDifferent) {
        userPubkey = currentUser.userPubkey;
        userPubkeyHex = currentUser.userPubkeyHex;
        
        // Reload everything when user logs in or pubkey changes
        loadRepos().catch(err => console.warn('Failed to reload repos after login:', err));
        loadLocalRepos().catch(err => console.warn('Failed to reload local repos after login:', err));
        loadMyRepos().catch(err => console.warn('Failed to load my repos after store sync:', err));
        loadContacts().catch(err => console.warn('Failed to load contacts after store sync:', err));
      }
    }
  });

  async function loadUserAndContacts() {
    // Check userStore first - if user is logged out, don't try to get pubkey
    const currentUser = $userStore;
    if (!currentUser.userPubkey || !currentUser.userPubkeyHex) {
      userPubkey = null;
      userPubkeyHex = null;
      contactPubkeys.clear();
      return;
    }

    // If userStore has user info, use it
    if (currentUser.userPubkey && currentUser.userPubkeyHex) {
      userPubkey = currentUser.userPubkey;
      userPubkeyHex = currentUser.userPubkeyHex;
      contactPubkeys.add(userPubkeyHex); // Include user's own repos
      
      // Still fetch contacts even if we have store data
      await loadContacts();
      return;
    }

    // Fallback: try to get from NIP-07 if store doesn't have it
    if (!isNIP07Available()) {
      return;
    }

    try {
      const pubkey = await getPublicKeyWithNIP07();
      if (!pubkey) return;
      
      userPubkey = pubkey;
      
      // Convert npub to hex for API calls
      // NIP-07 may return either npub or hex, so check format first
      if (/^[0-9a-f]{64}$/i.test(userPubkey)) {
        // Already hex format
        userPubkeyHex = userPubkey.toLowerCase();
        contactPubkeys.add(userPubkeyHex); // Include user's own repos
      } else {
        // Try to decode as npub
        try {
          const decoded = nip19.decode(userPubkey);
          if (decoded.type === 'npub') {
            userPubkeyHex = decoded.data as string;
            contactPubkeys.add(userPubkeyHex); // Include user's own repos
          }
        } catch (err) {
          // If decode fails, might still be hex or invalid - skip
          console.warn('Failed to decode user pubkey:', err);
        }
      }
      
      if (userPubkeyHex) {
        await loadContacts();
      }
    } catch (err) {
      console.warn('Failed to load user or contacts:', err);
    }
  }

  async function loadContacts() {
    if (!userPubkeyHex) return;
    
    try {
      // Fetch user's kind 3 contact list
      const contactEvents = await nostrClient.fetchEvents([
        {
          kinds: [KIND.CONTACT_LIST],
          authors: [userPubkeyHex],
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
      console.warn('Failed to load contacts:', err);
    }
  }

  async function loadMyRepos() {
    if (!userPubkey || !userPubkeyHex) {
      myRepos = [];
      return;
    }

    loadingMyRepos = true;
    try {
      // Fetch all repos where user is current owner
      const ownerRepos = await nostrClient.fetchEvents([
        {
          kinds: [KIND.REPO_ANNOUNCEMENT],
          authors: [userPubkeyHex],
          limit: 100
        }
      ]);

      const repos: Array<{ event: NostrEvent; npub: string; repoName: string; transferred?: boolean; currentOwner?: string }> = [];
      
      // Add repos where user is current owner
      for (const event of ownerRepos) {
        const dTag = event.tags.find(t => t[0] === 'd')?.[1];
        if (!dTag) continue;
        
        try {
          const npub = nip19.npubEncode(event.pubkey);
          repos.push({
            event,
            npub,
            repoName: dTag,
            transferred: false
          });
        } catch (err) {
          console.warn('Failed to encode npub for repo:', err);
        }
      }

      // Fetch repos that were transferred FROM this user (where they were original owner)
      // Search for transfer events where this user is the 'from' pubkey
      const { OwnershipTransferService } = await import('$lib/services/nostr/ownership-transfer-service.js');
      const ownershipService = new OwnershipTransferService(DEFAULT_NOSTR_RELAYS);
      
      // Get all repos where user was original owner
      const originalOwnerRepos = await nostrClient.fetchEvents([
        {
          kinds: [KIND.REPO_ANNOUNCEMENT],
          authors: [userPubkeyHex],
          limit: 100
        }
      ]);

      for (const originalEvent of originalOwnerRepos) {
        const dTag = originalEvent.tags.find(t => t[0] === 'd')?.[1];
        if (!dTag) continue;

        // Check current owner
        const currentOwner = await ownershipService.getCurrentOwner(userPubkeyHex, dTag);
        
        // If current owner is different, this repo was transferred
        if (currentOwner !== userPubkeyHex) {
          // Fetch the current announcement from the new owner
          const currentAnnouncements = await nostrClient.fetchEvents([
            {
              kinds: [KIND.REPO_ANNOUNCEMENT],
              authors: [currentOwner],
              '#d': [dTag],
              limit: 1
            }
          ]);

          if (currentAnnouncements.length > 0) {
            try {
              const npub = nip19.npubEncode(userPubkeyHex); // Original owner npub
              repos.push({
                event: currentAnnouncements[0], // Use current announcement
                npub,
                repoName: dTag,
                transferred: true,
                currentOwner
              });
            } catch (err) {
              console.warn('Failed to encode npub for transferred repo:', err);
            }
          }
        }
      }

      // Sort by created_at descending (newest first)
      repos.sort((a, b) => b.event.created_at - a.event.created_at);
      
      myRepos = repos;
    } catch (err) {
      console.warn('Failed to load my repos:', err);
      myRepos = [];
    } finally {
      loadingMyRepos = false;
    }
  }

  async function loadRepos() {
    loading = true;
    error = null;
    
    try {
      const gitDomain = $page.data.gitDomain || 'localhost:6543';
      const url = `/api/repos/list?domain=${encodeURIComponent(gitDomain)}`;
      
      const response = await fetch(url, {
        headers: userPubkeyHex ? {
          'X-User-Pubkey': userPubkeyHex
        } : {}
      });
      
      if (!response.ok) {
        throw new Error(`Failed to load repositories: ${response.statusText}`);
      }
      
      const data = await response.json();
      
      // API returns { registered, total }
      registeredRepos = data.registered || [];
      allRegisteredRepos = [...registeredRepos];
      
      // Load fork counts for registered repos (in parallel, but don't block)
      loadForkCounts(registeredRepos.map(r => r.event)).catch(err => {
        console.warn('[RepoList] Failed to load some fork counts:', err);
      });
      
      // Load local repos separately (async, don't block)
      loadLocalRepos();
    } catch (e) {
      error = String(e);
      console.error('[RepoList] Failed to load repos:', e);
    } finally {
      loading = false;
    }
  }
  
  async function loadLocalRepos() {
    loadingLocal = true;
    
    try {
      const gitDomain = $page.data.gitDomain || 'localhost:6543';
      const url = `/api/repos/local?domain=${encodeURIComponent(gitDomain)}`;
      
      const response = await fetch(url, {
        headers: userPubkeyHex ? {
          'X-User-Pubkey': userPubkeyHex
        } : {}
      });
      
      if (!response.ok) {
        console.warn('Failed to load local repos:', response.statusText);
        return;
      }
      
      const data = await response.json();
      // API returns array of { npub, repoName, announcement }
      localRepos = data.map((item: { npub: string; repoName: string; announcement: NostrEvent }) => ({
        npub: item.npub,
        repoName: item.repoName,
        announcement: item.announcement,
        lastModified: item.announcement?.created_at ? item.announcement.created_at * 1000 : Date.now()
      }));
      allLocalRepos = [...localRepos];
    } catch (e) {
      console.warn('[RepoList] Failed to load local repos:', e);
    } finally {
      loadingLocal = false;
    }
  }
  
  async function deleteLocalRepo(npub: string, repo: string) {
    if (!confirm(`Are you sure you want to delete the local clone of ${repo}? This will remove the repository from this server but will not delete the announcement on Nostr.`)) {
      return;
    }
    
    deletingRepo = { npub, repo };
    
    try {
      const response = await fetch(`/api/repos/${npub}/${repo}/delete`, {
        method: 'DELETE',
        headers: userPubkeyHex ? {
          'X-User-Pubkey': userPubkeyHex
        } : {}
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to delete repository');
      }
      
      // Remove from local repos list
      localRepos = localRepos.filter(r => !(r.npub === npub && r.repoName === repo));
      allLocalRepos = [...localRepos];
      
      alert('Repository deleted successfully');
    } catch (e) {
      alert(`Failed to delete repository: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      deletingRepo = null;
    }
  }
  
  function registerRepo(npub: string, repo: string) {
    // Navigate to signup page with repo pre-filled
    goto(`/signup?npub=${encodeURIComponent(npub)}&repo=${encodeURIComponent(repo)}`);
  }

  async function loadMostFavoritedRepos() {
    // Check cache first
    if (mostFavoritedCache && Date.now() - mostFavoritedCache.timestamp < CACHE_TTL) {
      updateMostFavoritedPage();
      return;
    }

    loadingMostFavorited = true;
    try {
      // Fetch up to 1000 bookmark events (kind 10003)
      const bookmarkEvents = await nostrClient.fetchEvents([
        {
          kinds: [KIND.BOOKMARKS],
          limit: 1000
        }
      ]);

      // Count how many times each repo a-tag appears
      const repoCounts = new Map<string, { count: number; aTag: string }>();
      
      for (const bookmark of bookmarkEvents) {
        for (const tag of bookmark.tags) {
          if (tag[0] === 'a' && tag[1]?.startsWith(`${KIND.REPO_ANNOUNCEMENT}:`)) {
            const aTag = tag[1];
            const current = repoCounts.get(aTag) || { count: 0, aTag };
            current.count++;
            repoCounts.set(aTag, current);
          }
        }
      }

      // Convert to array and sort by count
      const repoCountsArray = Array.from(repoCounts.entries())
        .map(([aTag, data]) => ({ aTag, count: data.count }))
        .sort((a, b) => b.count - a.count);

      // Fetch repo announcements for the top repos
      const topRepos: Array<{ event: NostrEvent; npub: string; repoName: string; favoriteCount: number }> = [];
      
      for (const { aTag, count } of repoCountsArray.slice(0, 100)) {
        // Parse a-tag: 30617:pubkey:d-tag
        const parts = aTag.split(':');
        if (parts.length >= 3) {
          const pubkey = parts[1];
          const dTag = parts[2];
          
          // Fetch the repo announcement
          const announcements = await nostrClient.fetchEvents([
            {
              kinds: [KIND.REPO_ANNOUNCEMENT],
              authors: [pubkey],
              '#d': [dTag],
              limit: 1
            }
          ]);

          if (announcements.length > 0) {
            try {
              const npub = nip19.npubEncode(pubkey);
              topRepos.push({
                event: announcements[0],
                npub,
                repoName: dTag,
                favoriteCount: count
              });
            } catch (err) {
              console.warn('Failed to encode npub for favorited repo:', err);
            }
          }
        }
      }

      // Cache the results
      mostFavoritedCache = {
        data: topRepos,
        timestamp: Date.now()
      };

      updateMostFavoritedPage();
    } catch (err) {
      console.error('Failed to load most favorited repos:', err);
    } finally {
      loadingMostFavorited = false;
    }
  }

  function updateMostFavoritedPage() {
    if (!mostFavoritedCache) return;
    
    const start = mostFavoritedPage * 10;
    const end = start + 10;
    mostFavoritedRepos = mostFavoritedCache.data.slice(start, end);
  }

  function nextMostFavoritedPage() {
    if (!mostFavoritedCache) return;
    const maxPage = Math.ceil(mostFavoritedCache.data.length / 10) - 1;
    if (mostFavoritedPage < maxPage) {
      mostFavoritedPage++;
      updateMostFavoritedPage();
    }
  }

  function prevMostFavoritedPage() {
    if (mostFavoritedPage > 0) {
      mostFavoritedPage--;
      updateMostFavoritedPage();
    }
  }

  // Background refresh of cache
  async function refreshMostFavoritedCache() {
    if (!mostFavoritedCache || Date.now() - mostFavoritedCache.timestamp >= CACHE_TTL) {
      await loadMostFavoritedRepos();
    }
  }

  // Start background refresh
  $effect(() => {
    if (typeof window !== 'undefined') {
      const interval = setInterval(() => {
        refreshMostFavoritedCache().catch(err => console.warn('Background refresh failed:', err));
      }, CACHE_TTL);
      return () => clearInterval(interval);
    }
  });

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
  
  function isOwner(npub: string, repoName: string): boolean {
    if (!userPubkeyHex) return false;
    try {
      const decoded = nip19.decode(npub);
      if (decoded.type === 'npub') {
        return (decoded.data as string) === userPubkeyHex;
      }
    } catch {
      // Invalid npub
    }
    return false;
  }

  function getRepoName(event: NostrEvent): string {
    const nameTag = event.tags.find((t: string[]) => t[0] === 'name' && t[1]);
    if (nameTag?.[1]) return nameTag[1];
    
    const dTag = event.tags.find((t: string[]) => t[0] === 'd')?.[1];
    if (dTag) return dTag;
    
    return `Repository ${event.id.slice(0, 8)}`;
  }

  function getRepoDescription(event: NostrEvent): string {
    const descTag = event.tags.find((t: string[]) => t[0] === 'description' && t[1]);
    return descTag?.[1] || '';
  }

  function getRepoImage(event: NostrEvent): string | null {
    const imageTag = event.tags.find((t: string[]) => t[0] === 'image' && t[1]);
    return imageTag?.[1] || null;
  }

  function getRepoBanner(event: NostrEvent): string | null {
    const bannerTag = event.tags.find((t: string[]) => t[0] === 'banner' && t[1]);
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

</script>

<svelte:head>
  <title>Repositories - GitRepublic</title>
  <meta name="description" content="Browse repositories on GitRepublic - Decentralized Git Hosting on Nostr" />
</svelte:head>

<div class="container">
  <main>
    {#if userPubkey && myRepos.length > 0}
      <div class="my-repos-section">
        <h3>My Repositories</h3>
        <div class="my-repos-badges">
          {#each myRepos as item}
            {@const repo = item.event}
            {@const repoImage = getRepoImage(repo)}
            {@const isTransferred = item.transferred || false}
            <a 
              href="/repos/{item.npub}/{item.repoName}" 
              class="repo-badge"
              class:transferred={isTransferred}
              title={isTransferred ? 'Transferred to another owner' : ''}
            >
              {#if repoImage}
                <img src={repoImage} alt={getRepoName(repo)} class="repo-badge-image" />
              {:else}
                <img src="/icons/package.svg" alt="Repository" class="repo-badge-icon" />
              {/if}
              <span class="repo-badge-name">{getRepoName(repo)}</span>
              {#if isTransferred}
                <span class="transferred-badge" title="Transferred">↗</span>
              {/if}
            </a>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Most Favorited Repositories -->
    <div class="most-favorited-section">
      <div class="section-header">
        <h3>Most Favorited Repositories</h3>
        {#if loadingMostFavorited}
          <span class="loading-indicator">Loading...</span>
        {/if}
      </div>
      {#if loadingMostFavorited && mostFavoritedRepos.length === 0}
        <div class="loading">Loading most favorited repositories...</div>
      {:else if mostFavoritedRepos.length === 0}
        <div class="empty">No favorited repositories found.</div>
      {:else}
        <div class="most-favorited-list">
          {#each mostFavoritedRepos as item}
            {@const repo = item.event}
            {@const repoImage = getRepoImage(repo)}
            <a href="/repos/{item.npub}/{item.repoName}" class="most-favorited-item">
              {#if repoImage}
                <img src={repoImage} alt={getRepoName(repo)} class="most-favorited-image" />
              {:else}
                <img src="/icons/package.svg" alt="Repository" class="most-favorited-icon" />
              {/if}
              <div class="most-favorited-info">
                <h4>{getRepoName(repo)}</h4>
                {#if getRepoDescription(repo)}
                  <p class="most-favorited-description">{getRepoDescription(repo)}</p>
                {/if}
                <span class="most-favorited-count">{item.favoriteCount} {item.favoriteCount === 1 ? 'favorite' : 'favorites'}</span>
              </div>
            </a>
          {/each}
        </div>
        {#if mostFavoritedCache && mostFavoritedCache.data.length > 10}
          <div class="pagination">
            <button onclick={prevMostFavoritedPage} disabled={mostFavoritedPage === 0}>
              Previous
            </button>
            <span class="page-info">
              Page {mostFavoritedPage + 1} of {Math.ceil(mostFavoritedCache.data.length / 10)}
            </span>
            <button 
              onclick={nextMostFavoritedPage} 
              disabled={mostFavoritedPage >= Math.ceil(mostFavoritedCache.data.length / 10) - 1}
            >
              Next
            </button>
          </div>
        {/if}
      {/if}
    </div>

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
    {:else}
      <!-- Registered Repositories Section -->
      <div class="repo-section">
        <div class="section-header">
          <h3>Registered Repositories</h3>
          <span class="section-badge">{registeredRepos.length}</span>
        </div>
        {#if registeredRepos.length === 0}
          <div class="empty">No registered repositories found.</div>
        {:else}
          <div class="repos-list">
            {#each registeredRepos as item}
              {@const repo = item.event}
              {@const repoImage = getRepoImage(repo)}
              {@const repoBanner = getRepoBanner(repo)}
              <div class="repo-card repo-card-registered">
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
                    <a href="/repos/{item.npub}/{item.repoName}" class="register-button">
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
      </div>

      <!-- Local Clones Section -->
      <div class="repo-section">
        <div class="section-header">
          <h3>Local Clones</h3>
          <span class="section-badge">{localRepos.length}</span>
          <span class="section-description">Repositories cloned locally but not registered with this domain</span>
        </div>
        {#if loadingLocal}
          <div class="loading">Loading local repositories...</div>
        {:else if localRepos.length === 0}
          <div class="empty">No local clones found.</div>
        {:else}
          <div class="repos-list">
            {#each localRepos as item}
              {@const repo = item.announcement}
              {@const repoImage = repo ? getRepoImage(repo) : null}
              {@const repoBanner = repo ? getRepoBanner(repo) : null}
              {@const canDelete = isOwner(item.npub, item.repoName)}
              <div class="repo-card repo-card-local">
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
                      <h3>{repo ? getRepoName(repo) : item.repoName}</h3>
                      {#if repo && getRepoDescription(repo)}
                        <p class="description">{getRepoDescription(repo)}</p>
                      {:else}
                        <p class="description">No description available</p>
                      {/if}
                    </div>
                    <div class="repo-actions">
                      <a href="/repos/{item.npub}/{item.repoName}" class="register-button">
                        View & Edit →
                      </a>
                      {#if userPubkey}
                        {#if canDelete}
                          <button 
                            class="delete-button"
                            onclick={() => deleteLocalRepo(item.npub, item.repoName)}
                            disabled={deletingRepo?.npub === item.npub && deletingRepo?.repo === item.repoName}
                          >
                            {deletingRepo?.npub === item.npub && deletingRepo?.repo === item.repoName ? 'Deleting...' : 'Delete'}
                          </button>
                        {:else if hasUnlimitedAccess($userStore.userLevel)}
                          <button 
                            class="register-button"
                            onclick={() => registerRepo(item.npub, item.repoName)}
                          >
                            Register
                          </button>
                        {/if}
                      {/if}
                    </div>
                  </div>
                  {#if repo}
                    <div class="clone-urls">
                      <strong>Clone URLs:</strong>
                      {#each getCloneUrls(repo) as url}
                        <code>{url}</code>
                      {/each}
                    </div>
                  {/if}
                  <div class="repo-meta">
                    <span>Last modified: {new Date(item.lastModified).toLocaleDateString()}</span>
                    {#if repo}
                      <span>Created: {new Date(repo.created_at * 1000).toLocaleDateString()}</span>
                      {#if getForkCount(repo) > 0}
                        {@const forkCount = getForkCount(repo)}
                        <span class="fork-count">🍴 {forkCount} fork{forkCount === 1 ? '' : 's'}</span>
                      {/if}
                    {/if}
                  </div>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </main>
</div>

<style>
  .most-favorited-section {
    margin: 2rem 0;
    padding: 1.5rem;
    background: var(--card-bg, #ffffff);
    border: 1px solid var(--border-color, #e0e0e0);
    border-radius: 0.5rem;
  }

  .most-favorited-section .section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
  }

  .most-favorited-section .section-header h3 {
    margin: 0;
    font-size: 1.25rem;
    color: var(--text-primary, #1a1a1a);
  }

  .loading-indicator {
    color: var(--text-secondary, #666);
    font-size: 0.875rem;
  }

  .most-favorited-list {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .most-favorited-item {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 1rem;
    background: var(--bg-secondary, #f5f5f5);
    border: 1px solid var(--border-color, #e0e0e0);
    border-radius: 0.5rem;
    text-decoration: none;
    color: inherit;
    transition: all 0.2s ease;
  }

  .most-favorited-item:hover {
    background: var(--bg-tertiary, #eeeeee);
    border-color: var(--accent, #007bff);
    transform: translateY(-2px);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  }

  .most-favorited-image,
  .most-favorited-icon {
    width: 48px;
    height: 48px;
    border-radius: 0.25rem;
    object-fit: cover;
    flex-shrink: 0;
  }

  .most-favorited-icon {
    padding: 8px;
    background: var(--bg-tertiary, #eeeeee);
  }

  .most-favorited-info {
    flex: 1;
    min-width: 0;
  }

  .most-favorited-info h4 {
    margin: 0 0 0.5rem 0;
    font-size: 1.1rem;
    color: var(--text-primary, #1a1a1a);
  }

  .most-favorited-description {
    margin: 0 0 0.5rem 0;
    color: var(--text-secondary, #666);
    font-size: 0.9rem;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  .most-favorited-count {
    display: inline-block;
    padding: 0.25rem 0.5rem;
    background: var(--accent, #007bff);
    color: var(--accent-text, #ffffff);
    border-radius: 0.25rem;
    font-size: 0.875rem;
    font-weight: 500;
  }

  .pagination {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 1rem;
    margin-top: 1.5rem;
    padding-top: 1.5rem;
    border-top: 1px solid var(--border-color, #e0e0e0);
  }

  .pagination button {
    padding: 0.5rem 1rem;
    background: var(--accent, #007bff);
    color: var(--accent-text, #ffffff);
    border: none;
    border-radius: 0.25rem;
    cursor: pointer;
    font-weight: 500;
    transition: all 0.2s ease;
  }

  .pagination button:hover:not(:disabled) {
    background: var(--accent-hover, #0056b3);
    transform: translateY(-1px);
  }

  .pagination button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .page-info {
    color: var(--text-secondary, #666);
    font-size: 0.9rem;
  }
</style>
