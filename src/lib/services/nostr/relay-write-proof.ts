/**
 * Service for verifying that a user can write to at least one default relay
 * This replaces rate limiting by requiring proof of relay write capability
 * 
 * Accepts NIP-98 events (kind 27235) as proof, since publishing a NIP-98 event
 * to a relay proves the user can write to that relay.
 */

import { verifyEvent } from 'nostr-tools';
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
 * 
 * Accepts:
 * - NIP-98 events (kind 27235) - preferred, since they're already used for HTTP auth
 * - Kind 1 (text note) events - for backward compatibility
 * 
 * The proof should be a recent event (within 60 seconds for NIP-98, 5 minutes for kind 1)
 * published to a default relay.
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

  // Determine time window based on event kind
  // NIP-98 events (27235) should be within 60 seconds per spec
  // Other events (like kind 1) can be within 5 minutes
  const isNIP98Event = proofEvent.kind === 27235;
  const maxAge = isNIP98Event ? 60 : 300; // 60 seconds for NIP-98, 5 minutes for others

  // Verify the event is recent
  const now = Math.floor(Date.now() / 1000);
  const eventAge = now - proofEvent.created_at;
  if (eventAge > maxAge) {
    return {
      valid: false,
      error: `Proof event is too old (must be within ${maxAge} seconds${isNIP98Event ? ' for NIP-98 events' : ''})`
    };
  }
  if (eventAge < 0) {
    return { valid: false, error: 'Proof event has future timestamp' };
  }

  // For NIP-98 events, validate they have required tags
  if (isNIP98Event) {
    const uTag = proofEvent.tags.find(t => t[0] === 'u');
    const methodTag = proofEvent.tags.find(t => t[0] === 'method');
    
    if (!uTag || !uTag[1]) {
      return { valid: false, error: "NIP-98 event missing 'u' tag" };
    }
    if (!methodTag || !methodTag[1]) {
      return { valid: false, error: "NIP-98 event missing 'method' tag" };
    }
    
    // Content should be empty for NIP-98
    if (proofEvent.content && proofEvent.content.trim() !== '') {
      return { valid: false, error: 'NIP-98 event content should be empty' };
    }
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
 * 
 * For new implementations, prefer using NIP-98 events (kind 27235) as they
 * serve dual purpose: HTTP authentication and relay write proof.
 * 
 * This function creates a simple kind 1 event for backward compatibility.
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

/**
 * Verify relay write proof from NIP-98 Authorization header
 * This is a convenience function that extracts the NIP-98 event from the
 * Authorization header and verifies it as relay write proof.
 * 
 * @param authHeader - The Authorization header value (should start with "Nostr ")
 * @param userPubkey - The expected user pubkey
 * @param relays - List of relays to check (defaults to DEFAULT_NOSTR_RELAYS)
 * @returns Verification result
 */
export async function verifyRelayWriteProofFromAuth(
  authHeader: string | null,
  userPubkey: string,
  relays: string[] = DEFAULT_NOSTR_RELAYS
): Promise<{ valid: boolean; error?: string; relay?: string }> {
  if (!authHeader || !authHeader.startsWith('Nostr ')) {
    return {
      valid: false,
      error: 'Missing or invalid Authorization header. Expected format: "Nostr <base64-encoded-event>"'
    };
  }

  try {
    // Decode base64 event
    const base64Event = authHeader.slice(7); // Remove "Nostr " prefix
    const eventJson = Buffer.from(base64Event, 'base64').toString('utf-8');
    const proofEvent: NostrEvent = JSON.parse(eventJson);

    // Verify as relay write proof
    return await verifyRelayWriteProof(proofEvent, userPubkey, relays);
  } catch (err) {
    return {
      valid: false,
      error: `Failed to parse Authorization header: ${err instanceof Error ? err.message : String(err)}`
    };
  }
}
