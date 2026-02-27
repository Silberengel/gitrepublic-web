/**
 * Shared utilities for Nostr event handling
 * Consolidates duplicate functions used across the codebase
 * 
 * Based on NIP-01: https://github.com/nostr-protocol/nips/blob/master/01.md
 */

import type { NostrEvent } from '../types/nostr.js';

/**
 * Check if an event is a parameterized replaceable event (addressable event per NIP-01)
 * 
 * According to NIP-01:
 * - Replaceable events (10000-19999, 0, 3): Replaceable by kind+pubkey only (no d-tag needed)
 * - Addressable events (30000-39999): Addressable by kind+pubkey+d-tag (d-tag required)
 * 
 * This function returns true only for addressable events (30000-39999) that have a d-tag,
 * as these are the events that require a parameter (d-tag) to be uniquely identified.
 * 
 * @param event - The Nostr event to check
 * @returns true if the event is an addressable event (30000-39999) with a d-tag
 */
export function isParameterizedReplaceable(event: NostrEvent): boolean {
  // Addressable events (30000-39999) require a d-tag to be addressable
  // Per NIP-01: "for kind n such that 30000 <= n < 40000, events are addressable
  // by their kind, pubkey and d tag value"
  if (event.kind >= 30000 && event.kind < 40000) {
    const hasDTag = event.tags.some(t => t[0] === 'd' && t[1]);
    return hasDTag;
  }
  
  // Replaceable events (10000-19999, 0, 3) are NOT parameterized replaceable
  // They are replaceable by kind+pubkey only, without needing a d-tag
  return false;
}
