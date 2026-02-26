<script lang="ts">
  /**
   * Generic publication index viewer for Nostr kind 30040
   * Renders publication indexes similar to NKBIP-01 and aitherboard
   */
  
  import { onMount } from 'svelte';
  import type { NostrEvent } from '$lib/types/nostr.js';
  import { NostrClient } from '$lib/services/nostr/nostr-client.js';
  import { DEFAULT_NOSTR_RELAYS } from '$lib/config.js';
  import logger from '$lib/services/logger.js';
  
  interface PublicationItem {
    id: string;
    title: string;
    description?: string;
    url?: string;
    tags?: string[][];
    [key: string]: any;
  }
  
  interface Props {
    indexEvent?: NostrEvent | null;
    relays?: string[];
    onItemClick?: ((item: PublicationItem) => void) | null;
  }
  
  let {
    indexEvent = null,
    relays = DEFAULT_NOSTR_RELAYS,
    onItemClick = null
  }: Props = $props();
  
  let items = $state<PublicationItem[]>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);
  
  $effect(() => {
    if (indexEvent) {
      loadIndex();
    }
  });
  
  async function loadIndex() {
    if (!indexEvent) return;
    
    loading = true;
    error = null;
    
    try {
      logger.operation('Loading publication index', { eventId: indexEvent.id });
      
      // Parse index event - kind 30040 typically has items in tags or content
      // Format: items can be in 'item' tags or JSON in content
      const itemTags = indexEvent.tags.filter(t => t[0] === 'item' || t[0] === 'p');
      
      if (indexEvent.content) {
        try {
          // Try parsing as JSON first
          const parsed = JSON.parse(indexEvent.content);
          if (Array.isArray(parsed)) {
            items = parsed;
          } else if (parsed.items && Array.isArray(parsed.items)) {
            items = parsed.items;
          } else {
            // Fallback to tag-based parsing
            items = parseItemsFromTags(itemTags);
          }
        } catch {
          // Not JSON, try parsing from tags
          items = parseItemsFromTags(itemTags);
        }
      } else {
        items = parseItemsFromTags(itemTags);
      }
      
      // If we have item IDs, fetch full events
      if (items.length > 0 && items[0].id) {
        await fetchItemDetails();
      }
      
      logger.operation('Publication index loaded', { itemCount: items.length });
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load publication index';
      logger.error({ error: err, eventId: indexEvent?.id }, 'Error loading publication index');
    } finally {
      loading = false;
    }
  }
  
  function parseItemsFromTags(tags: string[][]): PublicationItem[] {
    const items: PublicationItem[] = [];
    
    for (const tag of tags) {
      if (tag.length < 2) continue;
      
      const [type, ...rest] = tag;
      
      if (type === 'item' || type === 'p') {
        // Format: ['item', 'event-id', 'relay-url', ...] or ['p', 'pubkey', 'relay', ...]
        const item: PublicationItem = {
          id: rest[0] || '',
          title: rest[1] || rest[0] || 'Untitled',
          url: rest[2] || undefined
        };
        
        // Look for title/description in subsequent tags
        const titleTag = indexEvent?.tags.find(t => t[0] === 'title' && t[1] === item.id);
        if (titleTag && titleTag[2]) {
          item.title = titleTag[2];
        }
        
        const descTag = indexEvent?.tags.find(t => t[0] === 'description' && t[1] === item.id);
        if (descTag && descTag[2]) {
          item.description = descTag[2];
        }
        
        items.push(item);
      }
    }
    
    return items;
  }
  
  async function fetchItemDetails() {
    if (items.length === 0) return;
    
    try {
      const client = new NostrClient(relays);
      const itemIds = items.map(item => item.id).filter(Boolean);
      
      if (itemIds.length === 0) return;
      
      // Fetch events for item IDs
      const events = await client.fetchEvents([
        {
          ids: itemIds,
          limit: itemIds.length
        }
      ]);
      
      // Merge event data into items
      const eventMap = new Map(events.map(e => [e.id, e]));
      items = items.map(item => {
        const event = eventMap.get(item.id);
        if (event) {
          return {
            ...item,
            title: item.title || extractTitle(event),
            description: item.description || event.content?.substring(0, 200),
            event
          };
        }
        return item;
      });
    } catch (err) {
      logger.warn({ error: err }, 'Failed to fetch item details');
    }
  }
  
  function extractTitle(event: NostrEvent): string {
    // Try to get title from tags
    const titleTag = event.tags.find(t => t[0] === 'title');
    if (titleTag && titleTag[1]) {
      return titleTag[1];
    }
    
    // Try to get title from subject tag
    const subjectTag = event.tags.find(t => t[0] === 'subject');
    if (subjectTag && subjectTag[1]) {
      return subjectTag[1];
    }
    
    // Fallback to first line of content
    if (event.content) {
      const firstLine = event.content.split('\n')[0].trim();
      if (firstLine.length > 0 && firstLine.length < 100) {
        return firstLine;
      }
    }
    
    return 'Untitled';
  }
</script>

<div class="publication-index">
  {#if loading}
    <div class="loading">Loading publication index...</div>
  {:else if error}
    <div class="error">{error}</div>
  {:else if items.length === 0}
    <div class="empty">No items found in publication index</div>
  {:else}
    <div class="items-list">
      {#each items as item}
        <div 
          class="item"
          onclick={() => onItemClick?.(item)}
          onkeydown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onItemClick?.(item);
            }
          }}
          role="button"
          tabindex="0"
        >
          <h3 class="item-title">{item.title}</h3>
          {#if item.description}
            <p class="item-description">{item.description}</p>
          {/if}
          {#if item.url}
            <a href={item.url} class="item-url" onclick={(e) => e.stopPropagation()}>
              {item.url}
            </a>
          {/if}
          <div class="item-meta">
            {#if item.id}
              <span class="item-id">ID: {item.id.substring(0, 16)}...</span>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .publication-index {
    padding: 1rem;
  }
  
  .loading, .error, .empty {
    padding: 2rem;
    text-align: center;
    color: var(--text-secondary);
  }
  
  .error {
    color: var(--accent-error);
  }
  
  .items-list {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  
  .item {
    padding: 1.5rem;
    border: 1px solid var(--border-color);
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.2s;
    background: var(--bg-secondary);
  }
  
  .item:hover {
    border-color: var(--accent-color);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
    transform: translateY(-2px);
  }
  
  .item-title {
    margin: 0 0 0.5rem 0;
    font-size: 1.1rem;
    font-weight: 600;
    color: var(--text-primary);
  }
  
  .item-description {
    margin: 0.5rem 0;
    color: var(--text-secondary);
    line-height: 1.5;
  }
  
  .item-url {
    display: inline-block;
    margin-top: 0.5rem;
    color: var(--accent-color);
    text-decoration: none;
    font-size: 0.9rem;
    word-break: break-all;
  }
  
  .item-url:hover {
    text-decoration: underline;
  }
  
  .item-meta {
    margin-top: 0.75rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--border-color);
    font-size: 0.85rem;
    color: var(--text-secondary);
  }
  
  .item-id {
    font-family: monospace;
  }
</style>
