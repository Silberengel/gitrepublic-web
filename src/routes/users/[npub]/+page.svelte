<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { NostrClient } from '$lib/services/nostr/nostr-client.js';
  import { DEFAULT_NOSTR_RELAYS } from '$lib/config.js';
  import { KIND } from '$lib/types/nostr.js';
  import { nip19 } from 'nostr-tools';
  import type { NostrEvent } from '$lib/types/nostr.js';

  const npub = ($page.params as { npub?: string }).npub || '';

  let loading = $state(true);
  let error = $state<string | null>(null);
  let userPubkey = $state<string | null>(null);
  let repos = $state<NostrEvent[]>([]);
  let userProfile = $state<{ name?: string; about?: string; picture?: string } | null>(null);

  const nostrClient = new NostrClient(DEFAULT_NOSTR_RELAYS);
  const gitDomain = $page.data.gitDomain || 'localhost:6543';

  onMount(async () => {
    await loadUserProfile();
  });

  async function loadUserProfile() {
    loading = true;
    error = null;

    try {
      // Decode npub to get pubkey
      const decoded = nip19.decode(npub);
      if (decoded.type !== 'npub') {
        error = 'Invalid npub format';
        return;
      }
      userPubkey = decoded.data as string;

      // Fetch user's repositories
      const repoEvents = await nostrClient.fetchEvents([
        {
          kinds: [KIND.REPO_ANNOUNCEMENT],
          authors: [userPubkey],
          limit: 100
        }
      ]);

      // Filter for repos that list our domain
      repos = repoEvents.filter(event => {
        const cloneUrls = event.tags
          .filter(t => t[0] === 'clone')
          .flatMap(t => t.slice(1))
          .filter(url => url && typeof url === 'string');
        
        return cloneUrls.some(url => url.includes(gitDomain));
      });

      // Sort by created_at descending
      repos.sort((a, b) => b.created_at - a.created_at);

      // Try to fetch user profile (kind 0)
      const profileEvents = await nostrClient.fetchEvents([
        {
          kinds: [0],
          authors: [userPubkey],
          limit: 1
        }
      ]);

      if (profileEvents.length > 0) {
        try {
          const profile = JSON.parse(profileEvents[0].content);
          userProfile = {
            name: profile.name,
            about: profile.about,
            picture: profile.picture
          };
        } catch {
          // Invalid JSON, ignore
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load user profile';
      console.error('Error loading user profile:', err);
    } finally {
      loading = false;
    }
  }

  function getRepoName(event: NostrEvent): string {
    return event.tags.find(t => t[0] === 'name')?.[1] || 
           event.tags.find(t => t[0] === 'd')?.[1] || 
           'Unnamed';
  }

  function getRepoDescription(event: NostrEvent): string {
    return event.tags.find(t => t[0] === 'description')?.[1] || '';
  }

  function getRepoId(event: NostrEvent): string {
    return event.tags.find(t => t[0] === 'd')?.[1] || '';
  }
</script>

<div class="container">
  <header>
    <a href="/" class="back-link">← Back to Repositories</a>
    <div class="profile-header">
      {#if userProfile?.picture}
        <img src={userProfile.picture} alt="Profile" class="profile-picture" />
      {:else}
        <div class="profile-picture-placeholder">
          {npub.slice(0, 2).toUpperCase()}
        </div>
      {/if}
      <div class="profile-info">
        <h1>{userProfile?.name || npub.slice(0, 16)}...</h1>
        {#if userProfile?.about}
          <p class="profile-about">{userProfile.about}</p>
        {/if}
        <p class="profile-npub">npub: {npub}</p>
      </div>
    </div>
  </header>

  <main>
    {#if error}
      <div class="error">Error: {error}</div>
    {/if}

    {#if loading}
      <div class="loading">Loading profile...</div>
    {:else}
      <div class="repos-section">
        <h2>Repositories ({repos.length})</h2>
        {#if repos.length === 0}
          <div class="empty">No repositories found</div>
        {:else}
          <div class="repo-grid">
            {#each repos as event}
              <div 
                class="repo-card" 
                role="button"
                tabindex="0"
                onclick={() => goto(`/repos/${npub}/${getRepoId(event)}`)}
                onkeydown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    goto(`/repos/${npub}/${getRepoId(event)}`);
                  }
                }}
                style="cursor: pointer;">
                <h3>{getRepoName(event)}</h3>
                {#if getRepoDescription(event)}
                  <p class="repo-description">{getRepoDescription(event)}</p>
                {/if}
                <div class="repo-meta">
                  <span class="repo-date">
                    {new Date(event.created_at * 1000).toLocaleDateString()}
                  </span>
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
  .container {
    max-width: 1200px;
    margin: 0 auto;
    padding: 2rem;
  }

  .back-link {
    display: inline-block;
    margin-bottom: 1rem;
    color: #007bff;
    text-decoration: none;
  }

  .back-link:hover {
    text-decoration: underline;
  }

  .profile-header {
    display: flex;
    gap: 1.5rem;
    align-items: flex-start;
    margin-bottom: 2rem;
    padding-bottom: 2rem;
    border-bottom: 1px solid #e0e0e0;
  }

  .profile-picture {
    width: 80px;
    height: 80px;
    border-radius: 50%;
    object-fit: cover;
  }

  .profile-picture-placeholder {
    width: 80px;
    height: 80px;
    border-radius: 50%;
    background: #007bff;
    color: white;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 2rem;
    font-weight: bold;
  }

  .profile-info h1 {
    margin: 0 0 0.5rem 0;
  }

  .profile-about {
    color: #666;
    margin: 0.5rem 0;
  }

  .profile-npub {
    color: #999;
    font-size: 0.9rem;
    margin: 0.5rem 0 0 0;
    font-family: monospace;
  }

  .repos-section {
    margin-top: 2rem;
  }

  .repos-section h2 {
    margin-bottom: 1rem;
  }

  .repo-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 1.5rem;
  }

  .repo-card {
    border: 1px solid #e0e0e0;
    border-radius: 8px;
    padding: 1.5rem;
    cursor: pointer;
    transition: box-shadow 0.2s;
  }

  .repo-card:hover {
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  }

  .repo-card h3 {
    margin: 0 0 0.5rem 0;
    color: #007bff;
  }

  .repo-description {
    color: #666;
    margin: 0.5rem 0;
    font-size: 0.9rem;
  }

  .repo-meta {
    margin-top: 1rem;
    padding-top: 1rem;
    border-top: 1px solid #f0f0f0;
    font-size: 0.85rem;
    color: #999;
  }

  .loading, .empty, .error {
    text-align: center;
    padding: 2rem;
    color: #666;
  }

  .error {
    color: #d32f2f;
    background: #ffebee;
    border-radius: 4px;
    padding: 1rem;
  }
</style>
