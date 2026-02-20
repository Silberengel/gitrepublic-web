/**
 * Utility functions for fetching and extracting user profile data from kind 0 events
 */

import { NostrClient } from '../services/nostr/nostr-client.js';
import { DEFAULT_NOSTR_RELAYS } from '../config.js';
import { nip19 } from 'nostr-tools';
import { persistentEventCache } from '../services/nostr/persistent-event-cache.js';
import type { NostrEvent } from '../types/nostr.js';
import { KIND } from '../types/nostr.js';

export interface UserProfile {
  displayName?: string;
  name?: string;
  nip05?: string;
}

/**
 * Fetch user's kind 0 event from cache or relays
 */
export async function fetchUserProfile(
  userPubkeyHex: string,
  relays: string[] = DEFAULT_NOSTR_RELAYS
): Promise<NostrEvent | null> {
  // Try cache first
  try {
    const cachedProfile = await persistentEventCache.getProfile(userPubkeyHex);
    if (cachedProfile) {
      return cachedProfile;
    }
  } catch (err) {
    console.warn('Failed to get profile from cache:', err);
  }

  // Fallback to relays
  try {
    const client = new NostrClient(relays);
      const events = await client.fetchEvents([
        {
          kinds: [0], // Kind 0 = profile metadata
          authors: [userPubkeyHex],
          limit: 1
        }
      ]);

    if (events.length > 0) {
      // Cache the profile for future use
      await persistentEventCache.setProfile(userPubkeyHex, events[0]).catch(console.warn);
      return events[0];
    }
  } catch (err) {
    console.warn('Failed to fetch profile from relays:', err);
  }

  return null;
}

/**
 * Extract user profile data from kind 0 event
 */
export function extractProfileData(profileEvent: NostrEvent | null): UserProfile {
  if (!profileEvent) {
    return {};
  }

  const profile: UserProfile = {};

  // Try to parse JSON content
  try {
    const content = JSON.parse(profileEvent.content);
    profile.displayName = content.display_name || content.displayName;
    profile.name = content.name;
    profile.nip05 = content.nip05;
  } catch {
    // Invalid JSON, try tags
  }

  // Check tags for nip05 (newer format)
  if (!profile.nip05) {
    const nip05Tag = profileEvent.tags.find((tag: string[]) => 
      (tag[0] === 'nip05' || tag[0] === 'l') && tag[1]
    );
    if (nip05Tag && nip05Tag[1]) {
      profile.nip05 = nip05Tag[1];
    }
  }

  return profile;
}

/**
 * Get user name with fallbacks: display_name -> name -> shortened npub (20 chars)
 */
export function getUserName(
  profile: UserProfile,
  userPubkeyHex: string,
  userPubkey?: string
): string {
  // Try display_name first
  if (profile.displayName && profile.displayName.trim()) {
    return profile.displayName.trim();
  }

  // Fallback to name
  if (profile.name && profile.name.trim()) {
    return profile.name.trim();
  }

  // Fallback to shortened npub (20 chars)
  const npub = userPubkey || (userPubkeyHex ? nip19.npubEncode(userPubkeyHex) : 'unknown');
  return npub.substring(0, 20);
}

/**
 * Get user email with fallbacks: NIP-05 -> shortenednpub@gitrepublic.web
 */
export function getUserEmail(
  profile: UserProfile,
  userPubkeyHex: string,
  userPubkey?: string
): string {
  // Try NIP-05 first
  if (profile.nip05 && profile.nip05.trim()) {
    return profile.nip05.trim();
  }

  // Fallback to shortenednpub@gitrepublic.web
  const npub = userPubkey || (userPubkeyHex ? nip19.npubEncode(userPubkeyHex) : 'unknown');
  const shortenedNpub = npub.substring(0, 20);
  return `${shortenedNpub}@gitrepublic.web`;
}

/**
 * Fetch and get user name with all fallbacks
 */
export async function fetchUserName(
  userPubkeyHex: string,
  userPubkey?: string,
  relays: string[] = DEFAULT_NOSTR_RELAYS
): Promise<string> {
  const profileEvent = await fetchUserProfile(userPubkeyHex, relays);
  const profile = extractProfileData(profileEvent);
  return getUserName(profile, userPubkeyHex, userPubkey);
}

/**
 * Fetch and get user email with all fallbacks
 */
export async function fetchUserEmail(
  userPubkeyHex: string,
  userPubkey?: string,
  relays: string[] = DEFAULT_NOSTR_RELAYS
): Promise<string> {
  const profileEvent = await fetchUserProfile(userPubkeyHex, relays);
  const profile = extractProfileData(profileEvent);
  return getUserEmail(profile, userPubkeyHex, userPubkey);
}
