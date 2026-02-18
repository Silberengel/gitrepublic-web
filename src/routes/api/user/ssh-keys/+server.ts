/**
 * SSH Key Attestation API
 * 
 * Allows users to submit Nostr-signed events that attest to ownership of SSH keys.
 * These attestations are stored server-side only (not published to Nostr relays).
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { extractRequestContext } from '$lib/utils/api-context.js';
import { storeAttestation, getUserAttestations, verifyAttestation, calculateSSHKeyFingerprint } from '$lib/services/ssh/ssh-key-attestation.js';
import { getCachedUserLevel } from '$lib/services/security/user-level-cache.js';
import { auditLogger } from '$lib/services/security/audit-logger.js';
import { verifyEvent } from 'nostr-tools';
import type { NostrEvent } from '$lib/types/nostr.js';
import { KIND } from '$lib/types/nostr.js';
import logger from '$lib/services/logger.js';

/**
 * POST /api/user/ssh-keys
 * Submit an SSH key attestation event
 * 
 * Body: { event: NostrEvent }
 * - event.kind must be 30001 (SSH_KEY_ATTESTATION)
 * - event.content must contain the SSH public key
 * - event must be signed by the user's Nostr key
 */
export const POST: RequestHandler = async (event) => {
  const requestContext = extractRequestContext(event);
  const clientIp = requestContext.clientIp || 'unknown';
  let attestationFingerprint: string | null = null;

  try {
    if (!requestContext.userPubkeyHex) {
      return error(401, 'Authentication required');
    }

    const body = await event.request.json();
    if (!body.event) {
      return error(400, 'Missing event in request body');
    }

    const attestationEvent: NostrEvent = body.event;
    
    // Calculate fingerprint for audit logging (before storing)
    try {
      if (attestationEvent.content) {
        attestationFingerprint = calculateSSHKeyFingerprint(attestationEvent.content);
      }
    } catch {
      // Ignore fingerprint calculation errors
    }

    // Verify event signature
    if (!verifyEvent(attestationEvent)) {
      return error(400, 'Invalid event signature');
    }

    // Verify event kind
    if (attestationEvent.kind !== KIND.SSH_KEY_ATTESTATION) {
      return error(400, `Invalid event kind: expected ${KIND.SSH_KEY_ATTESTATION}, got ${attestationEvent.kind}`);
    }

    // Verify event is from the authenticated user
    if (attestationEvent.pubkey !== requestContext.userPubkeyHex) {
      return error(403, 'Event pubkey does not match authenticated user');
    }

    // Check user has unlimited access (same requirement as messaging forwarding)
    const userLevel = getCachedUserLevel(requestContext.userPubkeyHex);
    if (!userLevel || userLevel.level !== 'unlimited') {
      return error(403, 'SSH key attestation requires unlimited access. Please verify you can write to at least one default Nostr relay.');
    }

    // Store attestation
    const attestation = storeAttestation(attestationEvent);

    // Audit log
    auditLogger.logSSHKeyAttestation(
      requestContext.userPubkeyHex,
      attestation.revoked ? 'revoke' : 'submit',
      attestation.sshKeyFingerprint,
      'success'
    );

    logger.info({
      userPubkey: requestContext.userPubkeyHex.slice(0, 16) + '...',
      fingerprint: attestation.sshKeyFingerprint.slice(0, 20) + '...',
      keyType: attestation.sshKeyType,
      revoked: attestation.revoked,
      clientIp
    }, 'SSH key attestation submitted');

    return json({
      success: true,
      attestation: {
        eventId: attestation.eventId,
        fingerprint: attestation.sshKeyFingerprint,
        keyType: attestation.sshKeyType,
        createdAt: attestation.createdAt,
        revoked: attestation.revoked
      }
    });
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : 'Failed to store SSH key attestation';
    
    // Audit log failure (if we have user context and fingerprint)
    if (requestContext.userPubkeyHex && attestationFingerprint) {
      auditLogger.logSSHKeyAttestation(
        requestContext.userPubkeyHex,
        'submit',
        attestationFingerprint,
        'failure',
        errorMessage
      );
    }
    
    logger.error({ error: e, clientIp }, 'Failed to store SSH key attestation');
    
    if (errorMessage.includes('Rate limit')) {
      return error(429, errorMessage);
    }
    if (errorMessage.includes('already attested')) {
      return error(409, errorMessage);
    }
    
    return error(500, errorMessage);
  }
};

/**
 * GET /api/user/ssh-keys
 * Get all SSH key attestations for the authenticated user
 */
export const GET: RequestHandler = async (event) => {
  const requestContext = extractRequestContext(event);
  const clientIp = requestContext.clientIp || 'unknown';

  try {
    if (!requestContext.userPubkeyHex) {
      return error(401, 'Authentication required');
    }

    const attestations = getUserAttestations(requestContext.userPubkeyHex);

    return json({
      attestations: attestations.map(a => ({
        eventId: a.eventId,
        fingerprint: a.sshKeyFingerprint,
        keyType: a.sshKeyType,
        createdAt: a.createdAt,
        revoked: a.revoked,
        revokedAt: a.revokedAt
      }))
    });
  } catch (e) {
    logger.error({ error: e, clientIp }, 'Failed to get SSH key attestations');
    return error(500, 'Failed to retrieve SSH key attestations');
  }
};

