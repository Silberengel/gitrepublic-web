<script lang="ts">
  import { onMount } from 'svelte';
  import { NostrClient } from '../services/nostr/nostr-client.js';
  import { DEFAULT_NOSTR_RELAYS } from '../config.js';
  import { KIND } from '../types/nostr.js';
  import { eventCache } from '../services/nostr/event-cache.js';
  import { nip19 } from 'nostr-tools';

  interface Props {
    pubkey: string;
    disableLink?: boolean;
  }

  let { pubkey, disableLink = false }: Props = $props();
  
  // Convert pubkey to npub for navigation
  function getNpub(): string {
    try {
      // Check if already npub format
      try {
        const decoded = nip19.decode(pubkey);
        if (decoded.type === 'npub') {
          return pubkey;
        }
      } catch {
        // Not an npub, continue to encode
      }
      // Convert hex pubkey to npub
      return nip19.npubEncode(pubkey);
    } catch {
      // If all fails, return as-is (will be handled by route)
      return pubkey;
    }
  }
  
  const profileUrl = `/users/${getNpub()}`;
  
  let userProfile = $state<{ name?: string; picture?: string } | null>(null);
  let loading = $state(true);

  const nostrClient = new NostrClient(DEFAULT_NOSTR_RELAYS);

  onMount(async () => {
    await loadUserProfile();
  });

  async function loadUserProfile() {
    try {
      // Check in-memory cache first for fastest lookups
      const cachedProfile = eventCache.getProfile(pubkey);
      if (cachedProfile) {
        try {
          const profile = JSON.parse(cachedProfile.content);
          userProfile = {
            name: profile.name,
            picture: profile.picture
          };
          loading = false;
          
          // Fetch fresh data in background to update cache (non-blocking)
          nostrClient.fetchEvents([
            {
              kinds: [0],
              authors: [pubkey],
              limit: 1
            }
          ]).then(profileEvents => {
            if (profileEvents.length > 0) {
              try {
                const freshProfile = JSON.parse(profileEvents[0].content);
                // Update if profile changed
                if (freshProfile.name !== profile.name || freshProfile.picture !== profile.picture) {
                  userProfile = {
                    name: freshProfile.name,
                    picture: freshProfile.picture
                  };
                }
              } catch {
                // Invalid JSON, ignore
              }
            }
          }).catch(() => {
            // Ignore background fetch errors
          });
          
          return;
        } catch {
          // Invalid JSON in cache, continue to fetch fresh
        }
      }
      
      // Check persistent cache (IndexedDB) if available (browser only)
      if (typeof window !== 'undefined') {
        try {
          const { persistentEventCache } = await import('../services/nostr/persistent-event-cache.js');
          const persistentProfile = await persistentEventCache.getProfile(pubkey);
          if (persistentProfile) {
            try {
              const profile = JSON.parse(persistentProfile.content);
              userProfile = {
                name: profile.name,
                picture: profile.picture
              };
              loading = false;
              
              // Also update in-memory cache for faster future lookups
              eventCache.setProfile(pubkey, persistentProfile);
              
              // Fetch fresh data in background (non-blocking)
              nostrClient.fetchEvents([
                {
                  kinds: [0],
                  authors: [pubkey],
                  limit: 1
                }
              ]).then(profileEvents => {
                if (profileEvents.length > 0) {
                  try {
                    const freshProfile = JSON.parse(profileEvents[0].content);
                    if (freshProfile.name !== profile.name || freshProfile.picture !== profile.picture) {
                      userProfile = {
                        name: freshProfile.name,
                        picture: freshProfile.picture
                      };
                    }
                  } catch {
                    // Invalid JSON, ignore
                  }
                }
              }).catch(() => {
                // Ignore background fetch errors
              });
              
              return;
            } catch {
              // Invalid JSON in persistent cache, continue to fetch fresh
            }
          }
        } catch {
          // Persistent cache not available, continue to fetch
        }
      }

      // No cache available, fetch from relays
      const profileEvents = await nostrClient.fetchEvents([
        {
          kinds: [0],
          authors: [pubkey],
          limit: 1
        }
      ]);

      if (profileEvents.length > 0) {
        try {
          const profile = JSON.parse(profileEvents[0].content);
          userProfile = {
            name: profile.name,
            picture: profile.picture
          };
        } catch {
          // Invalid JSON, ignore
        }
      }
    } catch (err) {
      console.warn('Failed to load user profile:', err);
    } finally {
      loading = false;
    }
  }

  function getShortNpub(): string {
    try {
      const npub = nip19.npubEncode(pubkey);
      return `${npub.slice(0, 8)}...${npub.slice(-4)}`;
    } catch {
      return `${pubkey.slice(0, 8)}...${pubkey.slice(-4)}`;
    }
  }

  function truncateHandle(handle: string | undefined): string {
    if (!handle) return getShortNpub();
    if (handle.length <= 20) return handle;
    return handle.slice(0, 20) + '...';
  }
</script>

{#if disableLink}
  <div class="user-badge">
    {#if userProfile?.picture}
      <img src={userProfile.picture} alt="Profile" class="user-badge-avatar" />
    {:else}
      <img src="/favicon.png" alt="Profile" class="user-badge-avatar user-badge-avatar-fallback" />
    {/if}
    <span class="user-badge-name">{truncateHandle(userProfile?.name)}</span>
  </div>
{:else}
  <a href={profileUrl} class="user-badge">
    {#if userProfile?.picture}
      <img src={userProfile.picture} alt="Profile" class="user-badge-avatar" />
    {:else}
      <img src="/favicon.png" alt="Profile" class="user-badge-avatar user-badge-avatar-fallback" />
    {/if}
    <span class="user-badge-name">{truncateHandle(userProfile?.name)}</span>
  </a>
{/if}

<style>
  .user-badge {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.25rem 0.75rem;
    border-radius: 1.5rem;
    background: var(--card-bg);
    border: 1px solid var(--border-color);
    transition: all 0.2s ease;
    text-decoration: none;
    color: inherit;
    cursor: pointer;
  }

  .user-badge:hover {
    border-color: var(--accent);
    background: var(--bg-secondary);
  }

  .user-badge-avatar {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    object-fit: cover;
    flex-shrink: 0;
  }

  .user-badge-avatar-fallback {
    filter: grayscale(100%);
    opacity: 0.7;
  }

  .user-badge-name {
    font-size: 0.875rem;
    color: var(--text-primary);
    font-weight: 500;
    white-space: nowrap;
  }

  /* Hide name on narrow screens, show only picture */
  @media (max-width: 768px) {
    .user-badge-name {
      display: none;
    }

    .user-badge {
      padding: 0.25rem;
    }
  }
</style>
