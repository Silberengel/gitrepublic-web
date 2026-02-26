<script lang="ts">
  import { NostrClient } from '$lib/services/nostr/nostr-client.js';
  import { DEFAULT_NOSTR_RELAYS } from '$lib/config.js';
  import type { NostrEvent } from '$lib/types/nostr.js';
  import UserBadge from './UserBadge.svelte';
  import {
    loadNostrLinks,
    processHtmlWithNostrLinks
  } from '$lib/utils/nostr-links.js';

  interface Props {
    html: string;
    relays?: string[];
  }

  let { html, relays = DEFAULT_NOSTR_RELAYS }: Props = $props();

  // Create client once per relay set
  let nostrClient = $state<NostrClient | null>(null);
  let lastRelays = $state<string>('');
  let nostrLinkEvents = $state<Map<string, NostrEvent>>(new Map());
  let nostrLinkProfiles = $state<Map<string, string>>(new Map()); // link -> pubkey hex
  let loading = $state(true);
  let lastHtml = $state<string>('');
  let version = $state(0); // Force reactivity when Maps update
  let loadingPromise: Promise<void> | null = null; // Track current loading promise

  // Initialize client when relays change
  $effect(() => {
    const relaysKey = JSON.stringify(relays);
    if (!nostrClient || lastRelays !== relaysKey) {
      nostrClient?.close();
      nostrClient = new NostrClient(relays);
      lastRelays = relaysKey;
    }
  });

  // Process HTML into parts - reactive so it re-computes when events/profiles load
  // Include version in dependency to force re-computation when Maps update
  const htmlParts = $derived.by(() => {
    if (!html) return [];
    // Access version to track it as a dependency
    version; // eslint-disable-line @typescript-eslint/no-unused-expressions
    return processHtmlWithNostrLinks(html, nostrLinkEvents, nostrLinkProfiles);
  });

  // Load events and profiles from nostr links
  async function loadEventsAndProfiles() {
    if (!html || !nostrClient) {
      loading = false;
      return;
    }
    
    const currentHtml = html;
    
    // Skip if html hasn't changed and we already have data
    if (currentHtml === lastHtml && nostrLinkEvents.size > 0) {
      loading = false;
      return;
    }
    
    // Skip if already loading the same HTML
    if (currentHtml === lastHtml && loadingPromise) {
      return;
    }
    
    // If HTML changed, cancel previous load
    if (currentHtml !== lastHtml) {
      loadingPromise = null;
    }
    
    loading = true;
    
    console.log('[NostrHtmlRenderer] Processing HTML, length:', currentHtml.length);
    
    // Clear existing maps and create new ones
    const newEventCache = new Map<string, NostrEvent>();
    const newProfileCache = new Map<string, string>();
    
    // Create and assign loading promise immediately
    loadingPromise = (async () => {
    try {
        await loadNostrLinks(currentHtml, nostrClient!, newEventCache, newProfileCache);
      console.log('[NostrHtmlRenderer] After loadNostrLinks - events:', newEventCache.size, 'profiles:', newProfileCache.size);
        
        // Only update if this is still the current HTML (prevent race conditions)
        if (currentHtml === html) {
          nostrLinkEvents = newEventCache;
          nostrLinkProfiles = newProfileCache;
          version++; // Increment to force derived to re-compute
          // Set lastHtml only after successful load to prevent re-triggering
          lastHtml = currentHtml;
        }
    } catch (err) {
      console.error('[NostrHtmlRenderer] Error loading nostr links:', err);
      } finally {
        // Only clear loading state if HTML hasn't changed (prevent race conditions)
        if (currentHtml === html) {
          loading = false;
          loadingPromise = null;
        }
      }
    })();
    
    await loadingPromise;
  }

  function formatTime(timestamp: number): string {
    return new Date(timestamp * 1000).toLocaleString();
  }

  // Load when html changes - use a more specific dependency
  $effect(() => {
    // Track html value to detect changes
    const currentHtml = html;
    const hasClient = !!nostrClient;
    
    if (currentHtml && hasClient) {
      // Only load if HTML actually changed (not just if we don't have data)
      // This prevents re-loading when component re-renders
      if (currentHtml !== lastHtml) {
      loadEventsAndProfiles();
      }
    } else if (!currentHtml) {
      loading = false;
      nostrLinkEvents = new Map();
      nostrLinkProfiles = new Map();
      lastHtml = '';
      loadingPromise = null;
    }
  });
</script>

<div class="nostr-html-renderer">
  {#if loading}
    <div class="loading">Loading nostr links...</div>
  {:else}
    {#each htmlParts as part}
      {#if part.type === 'html'}
        {@html part.content}
      {:else if part.type === 'profile' && part.pubkey}
        <UserBadge pubkey={part.pubkey} />
      {:else if part.type === 'event' && part.event}
        <div class="nostr-link-event">
          <div class="nostr-link-event-header">
            <UserBadge pubkey={part.event.pubkey} />
            <span class="nostr-link-event-time">
              {formatTime(part.event.created_at)}
            </span>
          </div>
          <div class="nostr-link-event-content">
            {part.event.content || '(No content)'}
          </div>
        </div>
      {:else}
        <span class="nostr-link-placeholder">{part.content}</span>
      {/if}
    {/each}
  {/if}
</div>

<style>
  .nostr-html-renderer {
    width: 100%;
  }

  .loading {
    padding: 0.5rem;
    color: var(--text-secondary, #666);
    font-size: 0.875rem;
  }

  .nostr-link-placeholder {
    color: var(--text-secondary, #666);
    font-style: italic;
  }

  .nostr-link-event {
    margin: 0.5rem 0;
    padding: 0.75rem;
    background: var(--bg-secondary, #f5f5f5);
    border: 1px solid var(--border-color, #e0e0e0);
    border-radius: 0.375rem;
  }

  .nostr-link-event-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }

  .nostr-link-event-time {
    font-size: 0.875rem;
    color: var(--text-secondary, #666);
  }

  .nostr-link-event-content {
    color: var(--text-primary, #1a1a1a);
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
