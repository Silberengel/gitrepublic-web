/**
 * Nostr link processing utilities
 * Handles parsing and loading of nostr: links
 */

import type { NostrEvent } from '$lib/types/nostr.js';
import { nip19 } from 'nostr-tools';
import { NostrClient } from '$lib/services/nostr/nostr-client.js';
import { DEFAULT_NOSTR_RELAYS } from '$lib/config.js';

export interface ParsedNostrLink {
  type: 'nevent' | 'naddr' | 'note1' | 'npub' | 'profile';
  value: string;
  start: number;
  end: number;
}

/**
 * Parse nostr: links from content
 */
export function parseNostrLinks(content: string): ParsedNostrLink[] {
  const links: ParsedNostrLink[] = [];
  const nostrLinkRegex = /nostr:(nevent1|naddr1|note1|npub1|nprofile1)[a-zA-Z0-9]+/g;
  let match;
  
  while ((match = nostrLinkRegex.exec(content)) !== null) {
    const fullMatch = match[0];
    const prefix = match[1];
    let type: 'nevent' | 'naddr' | 'note1' | 'npub' | 'profile';
    
    if (prefix === 'nevent1') type = 'nevent';
    else if (prefix === 'naddr1') type = 'naddr';
    else if (prefix === 'note1') type = 'note1';
    else if (prefix === 'npub1') type = 'npub';
    else if (prefix === 'nprofile1') type = 'profile';
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
 * Get event from nostr link
 */
export function getEventFromNostrLink(link: string): NostrEvent | undefined {
  try {
    const decoded = nip19.decode(link.replace('nostr:', ''));
    if (decoded.type === 'nevent' || decoded.type === 'note') {
      return decoded.data as NostrEvent;
    }
  } catch {
    // Invalid link
  }
  return undefined;
}

/**
 * Get pubkey from nostr link
 */
export function getPubkeyFromNostrLink(link: string): string | undefined {
  try {
    const decoded = nip19.decode(link.replace('nostr:', ''));
    if (decoded.type === 'npub' || decoded.type === 'nprofile') {
      return decoded.data as string;
    }
  } catch {
    // Invalid link
  }
  return undefined;
}

/**
 * Process content with nostr links, replacing them with event/profile data
 */
export function processContentWithNostrLinks(
  content: string,
  events: Map<string, NostrEvent>,
  profiles: Map<string, any>
): Array<{ type: 'text' | 'event' | 'profile' | 'placeholder'; value: string; event?: NostrEvent; pubkey?: string }> {
  const links = parseNostrLinks(content);
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

  return parts.length > 0 ? parts : [{ type: 'text', value: content }];
}

/**
 * Load events and profiles from nostr links
 */
export async function loadNostrLinks(
  content: string,
  setEvents: (events: Map<string, NostrEvent>) => void,
  setProfiles: (profiles: Map<string, any>) => void
): Promise<void> {
  const links = parseNostrLinks(content);
  if (links.length === 0) return;

  const eventIds: string[] = [];
  const aTags: string[] = [];
  const npubs: string[] = [];

  for (const link of links) {
    try {
      const decoded = nip19.decode(link.value.replace('nostr:', ''));
      if (decoded.type === 'nevent') {
        const data = decoded.data as { id: string; relays?: string[] };
        if (data.id) eventIds.push(data.id);
      } else if (decoded.type === 'naddr') {
        const data = decoded.data as { identifier: string; pubkey: string; relays?: string[] };
        if (data.identifier && data.pubkey) {
          aTags.push(`${data.pubkey}:${data.identifier}`);
        }
      } else if (decoded.type === 'note') {
        eventIds.push(decoded.data as string);
      } else if (decoded.type === 'npub' || decoded.type === 'nprofile') {
        npubs.push(decoded.data as string);
      }
    } catch {
      // Invalid link, skip
    }
  }

  if (eventIds.length === 0 && aTags.length === 0 && npubs.length === 0) return;

  const client = new NostrClient(DEFAULT_NOSTR_RELAYS);
  const eventsMap = new Map<string, NostrEvent>();
  const profilesMap = new Map<string, any>();

  // Load events
  if (eventIds.length > 0) {
    try {
      const events = await client.fetchEvents([
        { ids: eventIds, limit: eventIds.length }
      ]);
      for (const event of events) {
        eventsMap.set(event.id, event);
      }
    } catch (err) {
      console.warn('Failed to load events from nostr links:', err);
    }
  }

  // Load profiles
  if (npubs.length > 0) {
    try {
      const profiles = await client.fetchEvents([
        { kinds: [0], authors: npubs, limit: npubs.length }
      ]);
      for (const profile of profiles) {
        try {
          const data = JSON.parse(profile.content);
          profilesMap.set(profile.pubkey, data);
        } catch {
          // Invalid JSON
        }
      }
    } catch (err) {
      console.warn('Failed to load profiles from nostr links:', err);
    }
  }

  setEvents(eventsMap);
  setProfiles(profilesMap);
}
