/**
 * Service for verifying that a user can write to at least one default relay
 * This is a trust mechanism - only users who can write to trusted default relays
 * get unlimited access. This limits access to trusted npubs.
 * 
 * The user only needs to be able to write to ONE of the default relays, not all.
 * If the proof event is found on any default relay, access is granted.
 * 
 * Accepts NIP-98 events (kind 27235) as proof, since publishing a NIP-98 event
 * to a relay proves the user can write to that relay.
 */

import { verifyEvent } from 'nostr-tools';
import type { NostrEvent } from '../../types/nostr.js';
import { KIND } from '../../types/nostr.js';
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
 * - Kind 24 (public message) events - for relay write proof
 *   - Must be addressed to the user themselves (their pubkey in the p tag)
 *   - User writes a public message to themselves on default relays to prove write access
 * 
 * The proof should be a recent event (within 60 seconds for NIP-98, 5 minutes for kind 24)
 * published to a default relay.
 */
export async function verifyRelayWriteProof(
  proofEvent: NostrEvent,
  userPubkey: string,
  relays: string[] = DEFAULT_NOSTR_RELAYS
): Promise<{ valid: boolean; error?: string; relay?: string; relayDown?: boolean }> {
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
  // Other events (like kind 24) can be within 5 minutes
  const isNIP98Event = proofEvent.kind === KIND.NIP98_AUTH;
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

  // For kind 24 (public message) events, validate they are addressed to the user themselves
  if (proofEvent.kind === KIND.PUBLIC_MESSAGE) {
    const pTag = proofEvent.tags.find(t => t[0] === 'p' && t[1]);
    if (!pTag || pTag[1] !== userPubkey) {
      return { valid: false, error: 'Public message proof must be addressed to the user themselves (p tag must contain user pubkey)' };
    }
  }

  // Try to verify the event exists on at least one default relay
  // User only needs write access to ONE of the default relays, not all
  // This is a trust mechanism - if they can write to any trusted relay, they're trusted
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
      return { valid: false, error: 'Proof event not found on any default relay. User must be able to write to at least one default relay.' };
    }

    // Verify the fetched event matches
    const fetchedEvent = events[0];
    if (fetchedEvent.id !== proofEvent.id) {
      return { valid: false, error: 'Fetched event does not match proof event' };
    }

    // Event found on at least one default relay - user has write access
    // We can't determine which specific relay(s) have it, but that's fine
    // The important thing is they can write to at least one trusted relay
    return { valid: true, relay: relays[0] }; // Return first relay as indication
  } catch (error) {
    // Relay connection failed - this is a network/relay issue, not an auth failure
    // Return a special error that indicates we should check cache
    return {
      valid: false,
      error: `Failed to verify proof on relays: ${error instanceof Error ? error.message : String(error)}`,
      relayDown: true // Flag to indicate relay connectivity issue
    };
  }
}

/**
 * Create a proof event that can be used to prove relay write capability
 * 
 * For new implementations, prefer using NIP-98 events (kind 27235) as they
 * serve dual purpose: HTTP authentication and relay write proof.
 * 
 * This function creates a kind 24 (public message) event addressed to the user
 * themselves (their own pubkey in the p tag) to prove they can write to default relays.
 */
export function createProofEvent(userPubkey: string, content: string = 'gitrepublic-write-proof'): Omit<NostrEvent, 'sig' | 'id'> {
  return {
    kind: KIND.PUBLIC_MESSAGE,
    pubkey: userPubkey,
    created_at: Math.floor(Date.now() / 1000),
    content: content,
    tags: [
      ['p', userPubkey], // Send to self to prove write access
      ['t', 'gitrepublic-proof']
    ]
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
