import { nip19 } from 'nostr-tools';
import type { NostrEvent } from '$lib/types/nostr.js';
import { NostrClient } from '$lib/services/nostr/nostr-client.js';

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

  // Fetch events
  if (eventIds.length > 0) {
    try {
      const events = await Promise.race([
        nostrClient.fetchEvents([{ ids: eventIds, limit: eventIds.length }]),
        new Promise<NostrEvent[]>((resolve) => setTimeout(() => resolve([]), 10000))
      ]);
      
      for (const event of events) {
        eventCache.set(event.id, event);
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
        return eventCache.get(decoded.data.id);
      } else if (decoded.type === 'note') {
        return eventCache.get(decoded.data as string);
      }
    } else if (link.startsWith('nostr:naddr1')) {
      const decoded = nip19.decode(link.replace('nostr:', ''));
      if (decoded.type === 'naddr') {
        return Array.from(eventCache.values()).find(e => {
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
