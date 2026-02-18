/**
 * SSH Key Verification API
 * 
 * Verify an SSH key fingerprint against stored attestations
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { extractRequestContext } from '$lib/utils/api-context.js';
import { verifyAttestation } from '$lib/services/ssh/ssh-key-attestation.js';
import logger from '$lib/services/logger.js';

/**
 * POST /api/user/ssh-keys/verify
 * Verify an SSH key fingerprint
 * 
 * Body: { fingerprint: string }
 * Returns the attestation if valid
 */
export const POST: RequestHandler = async (event) => {
  const requestContext = extractRequestContext(event);
  const clientIp = requestContext.clientIp || 'unknown';

  try {
    const body = await event.request.json();
    if (!body.fingerprint) {
      return error(400, 'Missing fingerprint in request body');
    }

    const attestation = verifyAttestation(body.fingerprint);

    if (!attestation) {
      return json({
        valid: false,
        message: 'SSH key not attested or attestation revoked'
      });
    }

    return json({
      valid: true,
      attestation: {
        userPubkey: attestation.userPubkey,
        fingerprint: attestation.sshKeyFingerprint,
        keyType: attestation.sshKeyType,
        createdAt: attestation.createdAt
      }
    });
  } catch (e) {
    logger.error({ error: e, clientIp }, 'Failed to verify SSH key');
    return error(500, 'Failed to verify SSH key');
  }
};
