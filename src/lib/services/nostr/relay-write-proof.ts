/**
 * Service for verifying that a user can write to at least one default relay
 * This replaces rate limiting by requiring proof of relay write capability
 */

import { verifyEvent, getEventHash } from 'nostr-tools';
import type { NostrEvent } from '../../types/nostr.js';
import { NostrClient } from './nostr-client.js';
import { DEFAULT_NOSTR_RELAYS } from '../../config.js';

export interface RelayWriteProof {
  event: NostrEvent;
  relay: string;
  timestamp: number;
}

/**
 * Verify that a user can write to at least one default relay
 * The proof should be a recent event (within last 5 minutes) published to a default relay
 */
export async function verifyRelayWriteProof(
  proofEvent: NostrEvent,
  userPubkey: string,
  relays: string[] = DEFAULT_NOSTR_RELAYS
): Promise<{ valid: boolean; error?: string; relay?: string }> {
  // Verify the event signature
  if (!verifyEvent(proofEvent)) {
    return { valid: false, error: 'Invalid event signature' };
  }

  // Verify the pubkey matches
  if (proofEvent.pubkey !== userPubkey) {
    return { valid: false, error: 'Event pubkey does not match user pubkey' };
  }

  // Verify the event is recent (within last 5 minutes)
  const now = Math.floor(Date.now() / 1000);
  const eventAge = now - proofEvent.created_at;
  if (eventAge > 300) { // 5 minutes
    return { valid: false, error: 'Proof event is too old (must be within 5 minutes)' };
  }
  if (eventAge < 0) {
    return { valid: false, error: 'Proof event has future timestamp' };
  }

  // Try to verify the event exists on at least one default relay
  const nostrClient = new NostrClient(relays);
  try {
    const events = await nostrClient.fetchEvents([
      {
        ids: [proofEvent.id],
        authors: [userPubkey],
        limit: 1
      }
    ]);

    if (events.length === 0) {
      return { valid: false, error: 'Proof event not found on any default relay' };
    }

    // Verify the fetched event matches
    const fetchedEvent = events[0];
    if (fetchedEvent.id !== proofEvent.id) {
      return { valid: false, error: 'Fetched event does not match proof event' };
    }

    // Determine which relay(s) have the event (we can't know for sure, but we verified it exists)
    return { valid: true, relay: relays[0] }; // Return first relay as indication
  } catch (error) {
    return {
      valid: false,
      error: `Failed to verify proof on relays: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

/**
 * Create a proof event that can be used to prove relay write capability
 * This is a simple kind 1 (text note) event with a specific content
 */
export function createProofEvent(userPubkey: string, content: string = 'gitrepublic-write-proof'): Omit<NostrEvent, 'sig' | 'id'> {
  return {
    kind: 1,
    pubkey: userPubkey,
    created_at: Math.floor(Date.now() / 1000),
    content: content,
    tags: [['t', 'gitrepublic-proof']]
  };
}
