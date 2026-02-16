/**
 * Service for verifying repository ownership
 * Creates and verifies cryptographic proof linking repo announcements to git repos
 */

import { getEventHash, verifyEvent } from 'nostr-tools';
import type { NostrEvent } from '../../types/nostr.js';
import { nip19 } from 'nostr-tools';

export interface VerificationFile {
  eventId: string;
  pubkey: string;
  npub: string;
  signature: string;
  timestamp: number;
}

/**
 * Generate a verification file content for a repository
 * This file should be committed to the repository to prove ownership
 */
export function generateVerificationFile(
  announcementEvent: NostrEvent,
  ownerPubkey: string
): string {
  const npub = nip19.npubEncode(ownerPubkey);
  
  const verification: VerificationFile = {
    eventId: announcementEvent.id,
    pubkey: ownerPubkey,
    npub: npub,
    signature: announcementEvent.sig,
    timestamp: announcementEvent.created_at
  };

  // Create a JSON file with clear formatting
  return JSON.stringify(verification, null, 2) + '\n';
}

/**
 * Verify that a repository announcement matches the verification file in the repo
 */
export function verifyRepositoryOwnership(
  announcementEvent: NostrEvent,
  verificationFileContent: string
): { valid: boolean; error?: string } {
  try {
    // Parse verification file
    const verification: VerificationFile = JSON.parse(verificationFileContent);

    // Check that the event ID matches
    if (verification.eventId !== announcementEvent.id) {
      return {
        valid: false,
        error: 'Verification file event ID does not match announcement'
      };
    }

    // Check that the pubkey matches
    if (verification.pubkey !== announcementEvent.pubkey) {
      return {
        valid: false,
        error: 'Verification file pubkey does not match announcement author'
      };
    }

    // Verify the announcement event signature
    if (!verifyEvent(announcementEvent)) {
      return {
        valid: false,
        error: 'Announcement event signature is invalid'
      };
    }

    // Verify the signature in the verification file matches the announcement
    if (verification.signature !== announcementEvent.sig) {
      return {
        valid: false,
        error: 'Verification file signature does not match announcement'
      };
    }

    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: `Failed to parse verification file: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

/**
 * Get the path where the verification file should be stored
 */
export const VERIFICATION_FILE_PATH = '.nostr-verification';
