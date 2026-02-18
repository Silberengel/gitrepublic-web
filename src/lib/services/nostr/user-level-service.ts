/**
 * Service for determining user access level based on relay write capability
 * 
 * SECURITY: User level verification is done server-side via API endpoint.
 * Client-side checks are only for UI purposes and can be bypassed.
 * 
 * Three tiers:
 * - unlimited: Users with write access to default relays
 * - rate_limited: Logged-in users without write access
 * - strictly_rate_limited: Not logged-in users
 */

import { signEventWithNIP07, isNIP07Available } from './nip07-signer.js';
import { KIND } from '../../types/nostr.js';
import { createProofEvent } from './relay-write-proof.js';
import { nip19 } from 'nostr-tools';
import { NostrClient } from './nostr-client.js';
import { DEFAULT_NOSTR_RELAYS } from '../../config.js';
import { hasUnlimitedAccess } from '../../utils/user-access.js';

export type UserLevel = 'unlimited' | 'rate_limited' | 'strictly_rate_limited';

export interface UserLevelResult {
  level: UserLevel;
  userPubkey: string | null;
  userPubkeyHex: string | null;
  error?: string;
}

/**
 * Check if a user can write to default relays by creating and verifying a proof event
 * SECURITY: This creates the proof event client-side, but verification is done server-side
 */
export async function checkRelayWriteAccess(
  userPubkeyHex: string
): Promise<{ hasAccess: boolean; error?: string }> {
  if (!isNIP07Available()) {
    return { hasAccess: false, error: 'NIP-07 extension not available' };
  }

  try {
    // Create a proof event (kind 24 public message)
    const proofEventTemplate = createProofEvent(
      userPubkeyHex,
      `gitrepublic-write-proof-${Date.now()}`
    );

    // Sign the event with NIP-07
    const signedEvent = await signEventWithNIP07(proofEventTemplate);

    // Publish the event to relays BEFORE verification
    // The server needs to be able to fetch it from relays to verify write access
    const nostrClient = new NostrClient(DEFAULT_NOSTR_RELAYS);
    const publishResult = await nostrClient.publishEvent(signedEvent, DEFAULT_NOSTR_RELAYS);
    
    // Wait a moment for the event to propagate to relays before verification
    // This gives relays time to process and index the event
    if (publishResult.success.length > 0) {
      await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
    } else {
      // If publishing failed to all relays, still try verification (might be cached)
      console.warn('Failed to publish proof event to any relay, but continuing with verification attempt');
    }

    // Verify server-side via API endpoint (secure)
    const response = await fetch('/api/user/level', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        proofEvent: signedEvent,
        userPubkeyHex
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
      return {
        hasAccess: false,
        error: errorData.error || `Server error: ${response.status}`
      };
    }

    const result = await response.json();
    
    return {
      hasAccess: hasUnlimitedAccess(result.level as UserLevel),
      error: result.error
    };
  } catch (error) {
    return {
      hasAccess: false,
      error: error instanceof Error ? error.message : 'Unknown error checking relay write access'
    };
  }
}

/**
 * Determine user level based on authentication and relay write access
 * This is the main function to call to get user level
 */
export async function determineUserLevel(
  userPubkey: string | null,
  userPubkeyHex: string | null
): Promise<UserLevelResult> {
  // Not logged in
  if (!userPubkey || !userPubkeyHex) {
    return {
      level: 'strictly_rate_limited',
      userPubkey: null,
      userPubkeyHex: null
    };
  }

  // Check if user has write access to default relays
  const writeAccess = await checkRelayWriteAccess(userPubkeyHex);
  
  if (writeAccess.hasAccess) {
    return {
      level: 'unlimited',
      userPubkey,
      userPubkeyHex
    };
  }

  // Logged in but no write access
  return {
    level: 'rate_limited',
    userPubkey,
    userPubkeyHex,
    error: writeAccess.error
  };
}

/**
 * Helper to decode npub to hex if needed
 * Handles both npub (bech32) and hex formats
 */
export function decodePubkey(pubkey: string): string | null {
  if (!pubkey) return null;
  
  // Check if it's already hex (64 characters, hex format)
  if (/^[0-9a-f]{64}$/i.test(pubkey)) {
    return pubkey.toLowerCase();
  }
  
  // Try to decode as npub (bech32)
  try {
    const decoded = nip19.decode(pubkey);
    if (decoded.type === 'npub') {
      return decoded.data as string;
    }
    return pubkey; // Unknown type, return as-is
  } catch {
    // Not a valid npub, assume it's already hex or return as-is
    return pubkey;
  }
}
