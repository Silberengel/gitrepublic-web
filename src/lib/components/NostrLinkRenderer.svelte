<script lang="ts">
  import { onMount } from 'svelte';
  import { NostrClient } from '$lib/services/nostr/nostr-client.js';
  import { DEFAULT_NOSTR_RELAYS } from '$lib/config.js';
  import { nip19 } from 'nostr-tools';
  import type { NostrEvent } from '$lib/types/nostr.js';
  import UserBadge from './UserBadge.svelte';

  interface Props {
    content: string;
  }

  let { content }: Props = $props();

  const nostrClient = new NostrClient(DEFAULT_NOSTR_RELAYS);
  let nostrLinkEvents = $state<Map<string, NostrEvent>>(new Map());
  let nostrLinkProfiles = $state<Map<string, string>>(new Map()); // npub link -> pubkey hex

  // Parse nostr: links from content
  function parseNostrLinks(text: string): Array<{ type: 'nevent' | 'naddr' | 'note1' | 'npub' | 'profile'; value: string; start: number; end: number }> {
    const links: Array<{ type: 'nevent' | 'naddr' | 'note1' | 'npub' | 'profile'; value: string; start: number; end: number }> = [];
    const nostrLinkRegex = /nostr:(nevent1|naddr1|note1|npub1|profile1)[a-zA-Z0-9]+/g;
    let match;
    
    while ((match = nostrLinkRegex.exec(text)) !== null) {
      const fullMatch = match[0];
      const prefix = match[1];
      let type: 'nevent' | 'naddr' | 'note1' | 'npub' | 'profile';
      
      if (prefix === 'nevent1') type = 'nevent';
      else if (prefix === 'naddr1') type = 'naddr';
      else if (prefix === 'note1') type = 'note1';
      else if (prefix === 'npub1') type = 'npub';
      else if (prefix === 'profile1') type = 'profile';
      else continue;
      
      links.push({
        type,
        value: fullMatch,
        start: match.index,
        end: match.index + fullMatch.length
      });
    }
    
    return links;
  }

  // Load events/profiles from nostr: links
  async function loadNostrLinks(text: string) {
    const links = parseNostrLinks(text);
    if (links.length === 0) return;

    const eventIds: string[] = [];
    const aTags: string[] = [];
    const npubs: string[] = [];

    for (const link of links) {
      try {
        if (link.type === 'nevent' || link.type === 'note1') {
          const decoded = nip19.decode(link.value.replace('nostr:', ''));
          if (decoded.type === 'nevent') {
            eventIds.push(decoded.data.id);
          } else if (decoded.type === 'note') {
            eventIds.push(decoded.data as string);
          }
        } else if (link.type === 'naddr') {
          const decoded = nip19.decode(link.value.replace('nostr:', ''));
          if (decoded.type === 'naddr') {
            const aTag = `${decoded.data.kind}:${decoded.data.pubkey}:${decoded.data.identifier}`;
            aTags.push(aTag);
          }
        } else if (link.type === 'npub' || link.type === 'profile') {
          const decoded = nip19.decode(link.value.replace('nostr:', ''));
          if (decoded.type === 'npub') {
            npubs.push(link.value);
            nostrLinkProfiles.set(link.value, decoded.data as string);
          }
        }
      } catch {
        // Invalid nostr link, skip
      }
    }

    // Fetch events
    if (eventIds.length > 0) {
      try {
        const events = await Promise.race([
          nostrClient.fetchEvents([{ ids: eventIds, limit: eventIds.length }]),
          new Promise<NostrEvent[]>((resolve) => setTimeout(() => resolve([]), 10000))
        ]);
        
        for (const event of events) {
          nostrLinkEvents.set(event.id, event);
        }
      } catch {
        // Ignore fetch errors
      }
    }

    // Fetch a-tag events
    if (aTags.length > 0) {
      for (const aTag of aTags) {
        const parts = aTag.split(':');
        if (parts.length === 3) {
          try {
            const kind = parseInt(parts[0]);
            const pubkey = parts[1];
            const dTag = parts[2];
            const events = await Promise.race([
              nostrClient.fetchEvents([{ kinds: [kind], authors: [pubkey], '#d': [dTag], limit: 1 }]),
              new Promise<NostrEvent[]>((resolve) => setTimeout(() => resolve([]), 10000))
            ]);
            
            if (events.length > 0) {
              nostrLinkEvents.set(events[0].id, events[0]);
            }
          } catch {
            // Ignore fetch errors
          }
        }
      }
    }
  }

  // Get event from nostr: link
  function getEventFromNostrLink(link: string): NostrEvent | undefined {
    try {
      if (link.startsWith('nostr:nevent1') || link.startsWith('nostr:note1')) {
        const decoded = nip19.decode(link.replace('nostr:', ''));
        if (decoded.type === 'nevent') {
          return nostrLinkEvents.get(decoded.data.id);
        } else if (decoded.type === 'note') {
          return nostrLinkEvents.get(decoded.data as string);
        }
      } else if (link.startsWith('nostr:naddr1')) {
        const decoded = nip19.decode(link.replace('nostr:', ''));
        if (decoded.type === 'naddr') {
          return Array.from(nostrLinkEvents.values()).find(e => {
            const dTag = e.tags.find(t => t[0] === 'd')?.[1];
            return e.kind === decoded.data.kind && 
                   e.pubkey === decoded.data.pubkey && 
                   dTag === decoded.data.identifier;
          });
        }
      }
    } catch {
      // Invalid link
    }
    return undefined;
  }

  // Get pubkey from nostr: npub/profile link
  function getPubkeyFromNostrLink(link: string): string | undefined {
    return nostrLinkProfiles.get(link);
  }

  // Process content with nostr links into parts for rendering
  function processContent(): Array<{ type: 'text' | 'event' | 'profile' | 'placeholder'; value: string; event?: NostrEvent; pubkey?: string }> {
    const links = parseNostrLinks(content);
    if (links.length === 0) {
      return [{ type: 'text', value: content }];
    }

    const parts: Array<{ type: 'text' | 'event' | 'profile' | 'placeholder'; value: string; event?: NostrEvent; pubkey?: string }> = [];
    let lastIndex = 0;

    for (const link of links) {
      // Add text before link
      if (link.start > lastIndex) {
        const textPart = content.slice(lastIndex, link.start);
        if (textPart) {
          parts.push({ type: 'text', value: textPart });
        }
      }

      // Add link
      const event = getEventFromNostrLink(link.value);
      const pubkey = getPubkeyFromNostrLink(link.value);
      if (event) {
        parts.push({ type: 'event', value: link.value, event });
      } else if (pubkey) {
        parts.push({ type: 'profile', value: link.value, pubkey });
      } else {
        parts.push({ type: 'placeholder', value: link.value });
      }

      lastIndex = link.end;
    }

    // Add remaining text
    if (lastIndex < content.length) {
      const textPart = content.slice(lastIndex);
      if (textPart) {
        parts.push({ type: 'text', value: textPart });
      }
    }

    return parts;
  }

  const parts = $derived(processContent());

  onMount(() => {
    loadNostrLinks(content);
  });

  $effect(() => {
    if (content) {
      loadNostrLinks(content);
    }
  });
</script>

{#each parts as part}
  {#if part.type === 'text'}
    {part.value}
  {:else if part.type === 'event' && part.event}
    <div class="nostr-link-event">
      <div class="nostr-link-event-header">
        <UserBadge pubkey={part.event.pubkey} />
        <span class="nostr-link-event-time">
          {new Date(part.event.created_at * 1000).toLocaleString()}
        </span>
      </div>
      <div class="nostr-link-event-content">
        {part.event.content}
      </div>
    </div>
  {:else if part.type === 'profile' && part.pubkey}
    <UserBadge pubkey={part.pubkey} />
  {:else if part.type === 'placeholder'}
    <span class="nostr-link-placeholder">{part.value}</span>
  {/if}
{/each}

<style>
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

  .nostr-link-placeholder {
    color: var(--text-secondary, #666);
    font-style: italic;
  }
</style>
