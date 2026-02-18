/**
 * SSH Key Attestation Service
 * 
 * Allows users to link their Nostr npub to SSH public keys for git operations.
 * Users sign a Nostr event (kind 30001) that proves ownership of an SSH key.
 * This attestation is stored server-side only (not published to Nostr relays).
 * 
 * SECURITY:
 * - Attestations are verified using Nostr event signatures
 * - SSH key fingerprints are stored (not full keys)
 * - Attestations can be revoked by submitting a new event with 'revoke' tag
 * - Rate limiting on attestation submissions
 */

import { createHash, createHmac } from 'crypto';
import { verifyEvent } from 'nostr-tools';
import type { NostrEvent } from '../../types/nostr.js';
import { KIND } from '../../types/nostr.js';
import logger from '../logger.js';

export interface SSHKeyAttestation {
  eventId: string;
  userPubkey: string;
  sshKeyFingerprint: string;
  sshKeyType: string; // e.g., 'ssh-rsa', 'ssh-ed25519', 'ecdsa-sha2-nistp256'
  sshPublicKey: string; // Full public key for verification
  createdAt: number;
  revoked: boolean;
  revokedAt?: number;
}

interface StoredAttestation {
  attestation: SSHKeyAttestation;
  lookupKey: string; // HMAC of fingerprint for database lookup
}

// In-memory storage (in production, use Redis or database)
// Key: HMAC(fingerprint), Value: StoredAttestation
const attestations = new Map<string, StoredAttestation>();

// Index by user pubkey for quick lookup
// Key: userPubkey, Value: Set of lookup keys
const userAttestations = new Map<string, Set<string>>();

// Rate limiting: track submissions per pubkey
interface SubmissionAttempt {
  count: number;
  resetAt: number;
}

const submissionAttempts = new Map<string, SubmissionAttempt>();
const MAX_SUBMISSIONS_PER_HOUR = 10;
const SUBMISSION_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// Cleanup expired rate limit entries
setInterval(() => {
  const now = Date.now();
  for (const [key, attempt] of submissionAttempts.entries()) {
    if (attempt.resetAt < now) {
      submissionAttempts.delete(key);
    }
  }
}, 5 * 60 * 1000); // Cleanup every 5 minutes

const LOOKUP_SECRET = process.env.SSH_ATTESTATION_LOOKUP_SECRET || 'change-me-in-production';

/**
 * Generate HMAC-based lookup key from SSH key fingerprint
 * Prevents fingerprint from being directly used as database key
 */
function getLookupKey(fingerprint: string): string {
  return createHmac('sha256', LOOKUP_SECRET)
    .update(fingerprint)
    .digest('hex');
}

/**
 * Calculate SSH key fingerprint (MD5 or SHA256)
 * Format: MD5: aa:bb:cc:dd... or SHA256: base64...
 * 
 * SSH public keys are in format: "key-type base64-key [comment]"
 * The comment field (optional) can contain NIP-05 identifiers or email addresses.
 * Only the key-type and base64-key are used for fingerprint calculation.
 */
export function calculateSSHKeyFingerprint(publicKey: string, algorithm: 'md5' | 'sha256' = 'sha256'): string {
  // SSH public keys are in format: "key-type base64-key [comment]"
  // Comment field is optional and can contain NIP-05 identifiers (e.g., "user@domain.com")
  const parts = publicKey.trim().split(/\s+/);
  if (parts.length < 2) {
    throw new Error('Invalid SSH public key format');
  }

  // Only use the key data (parts[1]) for fingerprint, ignore comment (parts[2+])
  const keyData = Buffer.from(parts[1], 'base64');
  
  if (algorithm === 'md5') {
    const hash = createHash('md5').update(keyData).digest('hex');
    return `MD5:${hash.match(/.{2}/g)?.join(':') || hash}`;
  } else {
    const hash = createHash('sha256').update(keyData).digest('base64');
    return `SHA256:${hash}`;
  }
}

/**
 * Extract SSH key type from public key
 */
function extractSSHKeyType(publicKey: string): string {
  const parts = publicKey.trim().split(/\s+/);
  return parts[0] || 'unknown';
}

/**
 * Check and enforce rate limiting on attestation submissions
 */
function checkRateLimit(userPubkey: string): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const attempt = submissionAttempts.get(userPubkey);
  
  if (!attempt || attempt.resetAt < now) {
    // Reset or create new attempt
    submissionAttempts.set(userPubkey, {
      count: 1,
      resetAt: now + SUBMISSION_WINDOW_MS
    });
    return { allowed: true, remaining: MAX_SUBMISSIONS_PER_HOUR - 1 };
  }
  
  if (attempt.count >= MAX_SUBMISSIONS_PER_HOUR) {
    return { allowed: false, remaining: 0 };
  }
  
  attempt.count++;
  return { allowed: true, remaining: MAX_SUBMISSIONS_PER_HOUR - attempt.count };
}

/**
 * Parse SSH key attestation from Nostr event
 * 
 * SSH public keys are in the format: "key-type base64-key [comment]"
 * The comment field is optional and can contain:
 * - Email addresses (e.g., "user@example.com")
 * - NIP-05 identifiers (e.g., "user@domain.com" - same format as email)
 * - Any other identifier
 */
function parseAttestationEvent(event: NostrEvent): {
  sshPublicKey: string;
  fingerprint: string;
  revoked: boolean;
} {
  // Content should contain the SSH public key
  // Format: "ssh-rsa AAAAB3NzaC1yc2E... [comment]"
  // The comment field (after the key data) can contain NIP-05 identifiers or email addresses
  const sshPublicKey = event.content.trim();
  if (!sshPublicKey) {
    throw new Error('SSH public key not found in event content');
  }

  // Check for revocation tag
  const revoked = event.tags.some(t => t[0] === 'revoke' && t[1] === 'true');

  // Calculate fingerprint
  const fingerprint = calculateSSHKeyFingerprint(sshPublicKey);

  return { sshPublicKey, fingerprint, revoked };
}

/**
 * Store SSH key attestation
 * 
 * @param event - Signed Nostr event (kind 30001) containing SSH public key
 * @returns Attestation record
 */
export function storeAttestation(event: NostrEvent): SSHKeyAttestation {
  // Verify event signature
  if (!verifyEvent(event)) {
    throw new Error('Invalid event signature');
  }

  // Verify event kind
  if (event.kind !== KIND.SSH_KEY_ATTESTATION) {
    throw new Error(`Invalid event kind: expected ${KIND.SSH_KEY_ATTESTATION}, got ${event.kind}`);
  }

  // Check rate limiting
  const rateLimit = checkRateLimit(event.pubkey);
  if (!rateLimit.allowed) {
    throw new Error(`Rate limit exceeded. Maximum ${MAX_SUBMISSIONS_PER_HOUR} attestations per hour.`);
  }

  // Parse attestation
  const { sshPublicKey, fingerprint, revoked } = parseAttestationEvent(event);

  // Check if this is a revocation
  if (revoked) {
    // Revoke existing attestation
    const lookupKey = getLookupKey(fingerprint);
    const stored = attestations.get(lookupKey);
    
    if (stored && stored.attestation.userPubkey === event.pubkey) {
      stored.attestation.revoked = true;
      stored.attestation.revokedAt = event.created_at;
      
      logger.info({ 
        userPubkey: event.pubkey.slice(0, 16) + '...',
        fingerprint: fingerprint.slice(0, 20) + '...',
        eventId: event.id
      }, 'SSH key attestation revoked');
      
      return stored.attestation;
    } else {
      throw new Error('No attestation found to revoke');
    }
  }

  // Create new attestation
  const lookupKey = getLookupKey(fingerprint);
  const existing = attestations.get(lookupKey);

  // If attestation exists and is not revoked, check if it's from the same user
  if (existing && !existing.attestation.revoked) {
    if (existing.attestation.userPubkey !== event.pubkey) {
      throw new Error('SSH key already attested by different user');
    }
    // Update existing attestation
    existing.attestation.eventId = event.id;
    existing.attestation.createdAt = event.created_at;
    existing.attestation.revoked = false;
    existing.attestation.revokedAt = undefined;
    
    logger.info({ 
      userPubkey: event.pubkey.slice(0, 16) + '...',
      fingerprint: fingerprint.slice(0, 20) + '...',
      eventId: event.id
    }, 'SSH key attestation updated');
    
    return existing.attestation;
  }

  // Create new attestation
  const attestation: SSHKeyAttestation = {
    eventId: event.id,
    userPubkey: event.pubkey,
    sshKeyFingerprint: fingerprint,
    sshKeyType: extractSSHKeyType(sshPublicKey),
    sshPublicKey: sshPublicKey,
    createdAt: event.created_at,
    revoked: false
  };

  // Store attestation
  attestations.set(lookupKey, { attestation, lookupKey });

  // Index by user pubkey
  if (!userAttestations.has(event.pubkey)) {
    userAttestations.set(event.pubkey, new Set());
  }
  userAttestations.get(event.pubkey)!.add(lookupKey);

  logger.info({ 
    userPubkey: event.pubkey.slice(0, 16) + '...',
    fingerprint: fingerprint.slice(0, 20) + '...',
    keyType: attestation.sshKeyType,
    eventId: event.id
  }, 'SSH key attestation stored');

  return attestation;
}

/**
 * Verify SSH key attestation
 * 
 * @param sshKeyFingerprint - SSH key fingerprint (MD5 or SHA256 format)
 * @returns Attestation if valid, null otherwise
 */
export function verifyAttestation(sshKeyFingerprint: string): SSHKeyAttestation | null {
  const lookupKey = getLookupKey(sshKeyFingerprint);
  const stored = attestations.get(lookupKey);
  
  if (!stored) {
    return null;
  }

  const { attestation } = stored;

  // Check if revoked
  if (attestation.revoked) {
    return null;
  }

  // Verify fingerprint matches
  if (attestation.sshKeyFingerprint !== sshKeyFingerprint) {
    return null;
  }

  return attestation;
}

/**
 * Get all attestations for a user
 * 
 * @param userPubkey - User's Nostr public key (hex)
 * @returns Array of attestations (including revoked ones)
 */
export function getUserAttestations(userPubkey: string): SSHKeyAttestation[] {
  const lookupKeys = userAttestations.get(userPubkey);
  if (!lookupKeys) {
    return [];
  }

  const results: SSHKeyAttestation[] = [];
  for (const lookupKey of lookupKeys) {
    const stored = attestations.get(lookupKey);
    if (stored && stored.attestation.userPubkey === userPubkey) {
      results.push(stored.attestation);
    }
  }

  return results.sort((a, b) => b.createdAt - a.createdAt); // Newest first
}

/**
 * Revoke an attestation
 * 
 * @param userPubkey - User's Nostr public key
 * @param fingerprint - SSH key fingerprint to revoke
 * @returns True if revoked, false if not found
 */
export function revokeAttestation(userPubkey: string, fingerprint: string): boolean {
  const lookupKey = getLookupKey(fingerprint);
  const stored = attestations.get(lookupKey);
  
  if (!stored || stored.attestation.userPubkey !== userPubkey) {
    return false;
  }

  stored.attestation.revoked = true;
  stored.attestation.revokedAt = Math.floor(Date.now() / 1000);

  logger.info({ 
    userPubkey: userPubkey.slice(0, 16) + '...',
    fingerprint: fingerprint.slice(0, 20) + '...'
  }, 'SSH key attestation revoked');

  return true;
}
