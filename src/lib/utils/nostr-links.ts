import { nip19 } from 'nostr-tools';
import type { NostrEvent } from '$lib/types/nostr.js';
import { NostrClient } from '$lib/services/nostr/nostr-client.js';
import { DEFAULT_NOSTR_SEARCH_RELAYS } from '$lib/config.js';
import { getUserRelays } from '$lib/services/nostr/user-relays.js';
import { KIND } from '$lib/types/nostr.js';

export interface ParsedNostrLink {
  type: 'nevent' | 'naddr' | 'note1' | 'npub' | 'nprofile';
  value: string;
  start: number;
  end: number;
}

export interface ProcessedContentPart {
  type: 'text' | 'event' | 'profile' | 'placeholder';
  value: string;
  event?: NostrEvent;
  pubkey?: string;
}

/**
 * Parse nostr: links from content string
 */
export function parseNostrLinks(content: string): ParsedNostrLink[] {
  const links: ParsedNostrLink[] = [];
  // Match nostr: links - be more permissive with characters to handle HTML entities
  // Note: bech32 uses base32 which is a-z, A-Z, 2-7, but we'll be more permissive
  const nostrLinkRegex = /nostr:(nevent1|naddr1|note1|npub1|nprofile1)[a-zA-Z0-9]+/g;
  let match;
  
  while ((match = nostrLinkRegex.exec(content)) !== null) {
    const fullMatch = match[0];
    const prefix = match[1];
    let type: 'nevent' | 'naddr' | 'note1' | 'npub' | 'nprofile';
    
    if (prefix === 'nevent1') type = 'nevent';
    else if (prefix === 'naddr1') type = 'naddr';
    else if (prefix === 'note1') type = 'note1';
    else if (prefix === 'npub1') type = 'npub';
    else if (prefix === 'nprofile1') type = 'nprofile';
    else continue;
    
    links.push({
      type,
      value: fullMatch,
      start: match.index,
      end: match.index + fullMatch.length
    });
  }
  
  if (links.length > 0) {
    console.log('[parseNostrLinks] Found', links.length, 'nostr links:', links.map(l => l.value));
  }
  
  return links;
}

/**
 * Load events and profiles from nostr: links in content
 */
export async function loadNostrLinks(
  content: string,
  nostrClient: NostrClient,
  eventCache: Map<string, NostrEvent>,
  profileCache: Map<string, string>
): Promise<void> {
  const links = parseNostrLinks(content);
  if (links.length === 0) return;

  const eventIds: string[] = [];
  const eventIdToRelays = new Map<string, string[]>(); // Map event ID to relay hints
  const eventIdToPubkey = new Map<string, string>(); // Map event ID to author pubkey (from nevent)
  const aTags: string[] = [];
  const aTagToRelays = new Map<string, string[]>(); // Map a-tag to relay hints
  const npubs: string[] = [];

  for (const link of links) {
    try {
      if (link.type === 'nevent' || link.type === 'note1') {
        const decoded = nip19.decode(link.value.replace('nostr:', ''));
        if (decoded.type === 'nevent') {
          const data = decoded.data as { id: string; pubkey?: string; relays?: string[] };
          eventIds.push(data.id);
          // Store relay hints if available
          if (data.relays && data.relays.length > 0) {
            eventIdToRelays.set(data.id, data.relays);
          }
          // Store author pubkey if available (for fetching their relay list)
          if (data.pubkey) {
            eventIdToPubkey.set(data.id, data.pubkey);
          }
        } else if (decoded.type === 'note') {
          eventIds.push(decoded.data as string);
        }
      } else if (link.type === 'naddr') {
        const decoded = nip19.decode(link.value.replace('nostr:', ''));
        if (decoded.type === 'naddr') {
          const data = decoded.data as { kind: number; pubkey: string; identifier: string; relays?: string[] };
          const aTag = `${data.kind}:${data.pubkey}:${data.identifier}`;
          aTags.push(aTag);
          // Store relay hints if available
          if (data.relays && data.relays.length > 0) {
            aTagToRelays.set(aTag, data.relays);
          }
        }
      } else if (link.type === 'npub' || link.type === 'nprofile') {
        const decoded = nip19.decode(link.value.replace('nostr:', ''));
        if (decoded.type === 'npub') {
          npubs.push(link.value);
          profileCache.set(link.value, decoded.data as string);
        } else if (decoded.type === 'nprofile') {
          npubs.push(link.value);
          profileCache.set(link.value, decoded.data.pubkey as string);
        }
      }
    } catch {
      // Invalid nostr link, skip
    }
  }

  // Collect all unique relay hints
  const relayHints = new Set<string>();
  for (const relays of eventIdToRelays.values()) {
    relays.forEach(r => relayHints.add(r));
  }
  for (const relays of aTagToRelays.values()) {
    relays.forEach(r => relayHints.add(r));
  }

  // Collect unique author pubkeys from nevent links
  const authorPubkeys = new Set<string>();
  for (const pubkey of eventIdToPubkey.values()) {
    authorPubkeys.add(pubkey);
  }

  // Fetch kind 10002 relay lists for all authors
  const authorRelays = new Set<string>();
  if (authorPubkeys.size > 0) {
    console.log('[loadNostrLinks] Fetching relay lists for', authorPubkeys.size, 'authors');
    // Use a temporary client with search relays to fetch relay lists
    const searchClient = new NostrClient(DEFAULT_NOSTR_SEARCH_RELAYS);
    for (const pubkey of authorPubkeys) {
      try {
        const userRelays = await getUserRelays(pubkey, searchClient);
        // Add both inbox and outbox relays (author might have published to either)
        userRelays.inbox.forEach(r => authorRelays.add(r));
        userRelays.outbox.forEach(r => authorRelays.add(r));
        console.log('[loadNostrLinks] Found', userRelays.inbox.length + userRelays.outbox.length, 'relays for author', pubkey.slice(0, 8) + '...');
      } catch (err) {
        console.warn('[loadNostrLinks] Error fetching relay list for author', pubkey.slice(0, 8) + '...', err);
      }
    }
    searchClient.close();
  }

  // Combine ALL relays: hints, author relays, search relays, and default relays
  const allRelays = new Set<string>();
  relayHints.forEach(r => allRelays.add(r));
  authorRelays.forEach(r => allRelays.add(r));
  DEFAULT_NOSTR_SEARCH_RELAYS.forEach(r => allRelays.add(r));
  // Also include default relays from the passed client
  // Note: We can't access the client's relays directly, but we'll use the client itself as fallback

  // Fetch events - try with ALL combined relays first
  if (eventIds.length > 0) {
    try {
      console.log('[loadNostrLinks] Fetching events:', eventIds);
      console.log('[loadNostrLinks] Relay hints:', Array.from(relayHints).length);
      console.log('[loadNostrLinks] Author relays:', Array.from(authorRelays).length);
      console.log('[loadNostrLinks] Total unique relays:', allRelays.size);
      
      let events: NostrEvent[] = [];
      const foundIds = new Set<string>();
      
      // Try fetching from ALL combined relays (hints + author relays + search relays)
      const combinedRelays = Array.from(allRelays);
      if (combinedRelays.length > 0) {
        const combinedClient = new NostrClient(combinedRelays);
        try {
          const fetched = await Promise.race([
            combinedClient.fetchEvents([{ ids: eventIds, limit: eventIds.length }]),
            new Promise<NostrEvent[]>((resolve) => setTimeout(() => resolve([]), 20000))
          ]);
          combinedClient.close();
          events.push(...fetched);
          fetched.forEach(e => foundIds.add(e.id));
          console.log('[loadNostrLinks] Fetched', fetched.length, 'events from combined relays');
        } catch (err) {
          console.warn('[loadNostrLinks] Error fetching from combined relays:', err);
          combinedClient.close();
        }
      }
      
      // If we didn't get all events, try default client as final fallback
      const missingIds = eventIds.filter(id => !foundIds.has(id));
      
      if (missingIds.length > 0) {
        console.log('[loadNostrLinks] Fetching', missingIds.length, 'missing events from default client');
        try {
          const defaultEvents = await Promise.race([
            nostrClient.fetchEvents([{ ids: missingIds, limit: missingIds.length }]),
            new Promise<NostrEvent[]>((resolve) => setTimeout(() => resolve([]), 15000))
      ]);
          events.push(...defaultEvents);
          defaultEvents.forEach(e => foundIds.add(e.id));
          console.log('[loadNostrLinks] Fetched', defaultEvents.length, 'additional events from default client');
        } catch (err) {
          console.warn('[loadNostrLinks] Error fetching from default client:', err);
        }
      }
      
      console.log('[loadNostrLinks] Total fetched:', events.length, 'events out of', eventIds.length, 'requested');
      for (const event of events) {
        eventCache.set(event.id, event);
        console.log('[loadNostrLinks] Stored event:', event.id);
      }
    } catch (err) {
      console.error('[loadNostrLinks] Error fetching events:', err);
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
          
          let events: NostrEvent[] = [];
          
          // Try relay hints first if available
          const hintRelays = aTagToRelays.get(aTag);
          if (hintRelays && hintRelays.length > 0) {
            const hintClient = new NostrClient(hintRelays);
            try {
              events = await Promise.race([
                hintClient.fetchEvents([{ kinds: [kind], authors: [pubkey], '#d': [dTag], limit: 1 }]),
                new Promise<NostrEvent[]>((resolve) => setTimeout(() => resolve([]), 10000))
              ]);
              hintClient.close();
            } catch {
              hintClient.close();
            }
          }
          
          // Fallback to default relays if no events found
          if (events.length === 0) {
            events = await Promise.race([
            nostrClient.fetchEvents([{ kinds: [kind], authors: [pubkey], '#d': [dTag], limit: 1 }]),
            new Promise<NostrEvent[]>((resolve) => setTimeout(() => resolve([]), 10000))
          ]);
          }
          
          if (events.length > 0) {
            eventCache.set(events[0].id, events[0]);
          }
        } catch {
          // Ignore fetch errors
        }
      }
    }
  }
}

/**
 * Get event from nostr: link
 */
export function getEventFromNostrLink(
  link: string,
  eventCache: Map<string, NostrEvent>
): NostrEvent | undefined {
  try {
    if (link.startsWith('nostr:nevent1') || link.startsWith('nostr:note1')) {
      const decoded = nip19.decode(link.replace('nostr:', ''));
      if (decoded.type === 'nevent') {
        const data = decoded.data as { id: string; relays?: string[] };
        const eventId = data.id;
        const event = eventCache.get(eventId);
        if (!event) {
          console.log('[getEventFromNostrLink] Event not found in cache:', eventId, 'Cache has:', Array.from(eventCache.keys()));
        }
        return event;
      } else if (decoded.type === 'note') {
        const eventId = decoded.data as string;
        const event = eventCache.get(eventId);
        if (!event) {
          console.log('[getEventFromNostrLink] Note event not found in cache:', eventId);
        }
        return event;
      }
    } else if (link.startsWith('nostr:naddr1')) {
      const decoded = nip19.decode(link.replace('nostr:', ''));
      if (decoded.type === 'naddr') {
        const data = decoded.data as { kind: number; pubkey: string; identifier: string; relays?: string[] };
        const event = Array.from(eventCache.values()).find(e => {
          const dTag = e.tags.find(t => t[0] === 'd')?.[1];
          return e.kind === data.kind && 
                 e.pubkey === data.pubkey && 
                 dTag === data.identifier;
        });
        if (!event) {
          console.log('[getEventFromNostrLink] Naddr event not found in cache:', data);
        }
        return event;
      }
    }
  } catch (err) {
    console.error('[getEventFromNostrLink] Error decoding link:', link, err);
  }
  return undefined;
}

/**
 * Get pubkey from nostr: npub/profile link
 */
export function getPubkeyFromNostrLink(
  link: string,
  profileCache: Map<string, string>
): string | undefined {
  return profileCache.get(link);
}

/**
 * Process content with nostr links into parts for rendering
 */
export function processContentWithNostrLinks(
  content: string,
  eventCache: Map<string, NostrEvent>,
  profileCache: Map<string, string>
): ProcessedContentPart[] {
  const links = parseNostrLinks(content);
  if (links.length === 0) {
    return [{ type: 'text', value: content }];
  }

  const parts: ProcessedContentPart[] = [];
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
    const event = getEventFromNostrLink(link.value, eventCache);
    const pubkey = getPubkeyFromNostrLink(link.value, profileCache);
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

/**
 * Get referenced event from discussion event (via 'e', 'a', or 'q' tag)
 */
export function getReferencedEventFromDiscussion(
  event: NostrEvent,
  eventCache: Map<string, NostrEvent>
): NostrEvent | undefined {
  // Check e-tag
  const eTag = event.tags.find(t => t[0] === 'e' && t[1])?.[1];
  if (eTag) {
    const referenced = eventCache.get(eTag);
    if (referenced) return referenced;
  }
  
  // Check a-tag
  const aTag = event.tags.find(t => t[0] === 'a' && t[1])?.[1];
  if (aTag) {
    const parts = aTag.split(':');
    if (parts.length === 3) {
      const kind = parseInt(parts[0]);
      const pubkey = parts[1];
      const dTag = parts[2];
      return Array.from(eventCache.values()).find(e => 
        e.kind === kind && 
        e.pubkey === pubkey && 
        e.tags.find(t => t[0] === 'd' && t[1] === dTag)
      );
    }
  }
  
  // Check q-tag
  const qTag = event.tags.find(t => t[0] === 'q' && t[1])?.[1];
  if (qTag) {
    return eventCache.get(qTag);
  }
  
  return undefined;
}

/**
 * Format timestamp for discussion display
 */
export function formatDiscussionTime(timestamp: number): string {
  const now = Date.now() / 1000;
  const diff = now - timestamp;
  
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  
  return new Date(timestamp * 1000).toLocaleDateString();
}

/**
 * Process HTML content with nostr links into parts for rendering
 * Similar to processContentWithNostrLinks but handles HTML properly
 */
export function processHtmlWithNostrLinks(
  html: string,
  eventCache: Map<string, NostrEvent>,
  profileCache: Map<string, string>
): Array<{ type: 'html' | 'event' | 'profile' | 'placeholder'; content: string; event?: NostrEvent; pubkey?: string }> {
  const links = parseNostrLinks(html);
  if (links.length === 0) {
    return [{ type: 'html', content: html }];
  }

  const parts: Array<{ type: 'html' | 'event' | 'profile' | 'placeholder'; content: string; event?: NostrEvent; pubkey?: string }> = [];
  let lastIndex = 0;

  for (const link of links) {
    // Add HTML before link
    if (link.start > lastIndex) {
      const htmlPart = html.slice(lastIndex, link.start);
      if (htmlPart) {
        parts.push({ type: 'html', content: htmlPart });
      }
    }

    // Add link
    const event = getEventFromNostrLink(link.value, eventCache);
    const pubkey = getPubkeyFromNostrLink(link.value, profileCache);
    if (event) {
      parts.push({ type: 'event', content: link.value, event });
    } else if (pubkey) {
      parts.push({ type: 'profile', content: link.value, pubkey });
    } else {
      parts.push({ type: 'placeholder', content: link.value });
    }

    lastIndex = link.end;
  }

  // Add remaining HTML
  if (lastIndex < html.length) {
    const htmlPart = html.slice(lastIndex);
    if (htmlPart) {
      parts.push({ type: 'html', content: htmlPart });
    }
  }

  return parts;
}
