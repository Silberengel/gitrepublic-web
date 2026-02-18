/**
 * Service for verifying repository ownership
 * Creates and verifies cryptographic proof linking repo announcements to git repos
 */

import { verifyEvent, getEventHash } from 'nostr-tools';
import { KIND } from '../../types/nostr.js';
import type { NostrEvent } from '../../types/nostr.js';

/**
 * Generate announcement event file content for a repository
 * This file should be committed to the repository to prove ownership
 * We just save the full announcement event JSON - simpler and more complete than a custom format
 */
export function generateVerificationFile(
  announcementEvent: NostrEvent,
  ownerPubkey: string
): string {
  // Just return the full announcement event JSON - it's already signed and contains all needed info
  return JSON.stringify(announcementEvent, null, 2) + '\n';
}

/**
 * Validate that an event is a legitimate repository announcement
 * Checks signature, kind, structure, and d-tag
 */
export function validateAnnouncementEvent(
  event: NostrEvent,
  expectedRepoName?: string
): { valid: boolean; error?: string } {
  // Verify it's a valid Nostr event structure
  if (!event.kind || !event.id || !event.sig || !event.pubkey || !event.created_at || !Array.isArray(event.tags)) {
    return {
      valid: false,
      error: 'Invalid event structure: missing required fields'
    };
  }

  // Verify it's actually a repository announcement (kind 30617)
  if (event.kind !== KIND.REPO_ANNOUNCEMENT) {
    return {
      valid: false,
      error: `Invalid event kind: expected ${KIND.REPO_ANNOUNCEMENT}, got ${event.kind}`
    };
  }

  // Verify the event signature cryptographically
  if (!verifyEvent(event)) {
    return {
      valid: false,
      error: 'Event signature is invalid - event may be forged or corrupted'
    };
  }

  // Verify the event ID matches the computed ID (prevents ID tampering)
  const computedId = getEventHash(event);
  if (computedId !== event.id) {
    return {
      valid: false,
      error: 'Event ID does not match computed hash - event may be tampered with'
    };
  }

  // Verify d-tag exists (required for repository announcements)
  const dTag = event.tags.find(t => t[0] === 'd');
  if (!dTag || !dTag[1]) {
    return {
      valid: false,
      error: 'Missing d-tag (repository identifier) in announcement event'
    };
  }

  // If expected repo name is provided, verify it matches
  if (expectedRepoName && dTag[1] !== expectedRepoName) {
    return {
      valid: false,
      error: `Repository name mismatch: expected '${expectedRepoName}', got '${dTag[1]}'`
    };
  }

  // Verify pubkey is valid hex format (64 characters)
  if (!/^[0-9a-f]{64}$/i.test(event.pubkey)) {
    return {
      valid: false,
      error: 'Invalid pubkey format'
    };
  }

  // Verify signature is valid hex format (128 characters)
  if (!/^[0-9a-f]{128}$/i.test(event.sig)) {
    return {
      valid: false,
      error: 'Invalid signature format'
    };
  }

  // Verify created_at is reasonable (not in the future, not too old)
  const now = Math.floor(Date.now() / 1000);
  const eventTime = event.created_at;
  if (eventTime > now + 60) {
    return {
      valid: false,
      error: 'Event timestamp is in the future'
    };
  }
  // Allow events up to 10 years old (reasonable for repository announcements)
  if (eventTime < now - (10 * 365 * 24 * 60 * 60)) {
    return {
      valid: false,
      error: 'Event timestamp is too old (more than 10 years)'
    };
  }

  return { valid: true };
}

/**
 * Verify that a repository announcement matches the file in the repo
 * The file should contain the full announcement event JSON
 */
export function verifyRepositoryOwnership(
  announcementEvent: NostrEvent,
  announcementFileContent: string
): { valid: boolean; error?: string } {
  try {
    // Parse the announcement event from the file
    const fileEvent: NostrEvent = JSON.parse(announcementFileContent);
    
    // First, validate the file event is a legitimate announcement
    const fileValidation = validateAnnouncementEvent(fileEvent);
    if (!fileValidation.valid) {
      return {
        valid: false,
        error: `File event validation failed: ${fileValidation.error}`
      };
    }

    // Validate the provided announcement event as well
    const announcementValidation = validateAnnouncementEvent(announcementEvent);
    if (!announcementValidation.valid) {
      return {
        valid: false,
        error: `Provided announcement validation failed: ${announcementValidation.error}`
      };
    }
    
    // Check that the event ID matches
    if (fileEvent.id !== announcementEvent.id) {
      return {
        valid: false,
        error: 'Announcement event ID does not match'
      };
    }
    
    // Check that the pubkey matches
    if (fileEvent.pubkey !== announcementEvent.pubkey) {
      return {
        valid: false,
        error: 'Announcement event pubkey does not match'
      };
    }
    
    // Check that the signature matches
    if (fileEvent.sig !== announcementEvent.sig) {
      return {
        valid: false,
        error: 'Announcement event signature does not match'
      };
    }

    // Check that the d-tag (repo name) matches
    const fileDTag = fileEvent.tags.find(t => t[0] === 'd')?.[1];
    const announcementDTag = announcementEvent.tags.find(t => t[0] === 'd')?.[1];
    if (fileDTag !== announcementDTag) {
      return {
        valid: false,
        error: 'Repository name (d-tag) does not match'
      };
    }

    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: `Failed to parse announcement file: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

/**
 * Get the path where the announcement event file should be stored
 */
export const VERIFICATION_FILE_PATH = '.nostr-announcement';
