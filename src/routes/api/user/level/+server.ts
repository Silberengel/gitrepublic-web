/**
 * API endpoint for verifying user level (relay write access)
 * This must be done server-side for security - client-side checks can be bypassed
 * 
 * User only needs to be able to write to ONE of the default relays, not all.
 * This is a trust mechanism - users who can write to trusted default relays
 * get unlimited access, limiting access to trusted npubs.
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { verifyRelayWriteProof } from '$lib/services/nostr/relay-write-proof.js';
import { DEFAULT_NOSTR_RELAYS } from '$lib/config.js';
import { auditLogger } from '$lib/services/security/audit-logger.js';
import { getCachedUserLevel, cacheUserLevel } from '$lib/services/security/user-level-cache.js';
import { extractRequestContext } from '$lib/utils/api-context.js';
import { sanitizeError } from '$lib/utils/security.js';
import { verifyEvent } from 'nostr-tools';
import logger from '$lib/services/logger.js';

export const POST: RequestHandler = async (event) => {
  const requestContext = extractRequestContext(event);
  const clientIp = requestContext.clientIp || 'unknown';
  
  try {
    const body = await event.request.json();
    const { proofEvent, userPubkeyHex } = body;

    // Validate input
    if (!proofEvent || !userPubkeyHex) {
      auditLogger.logAuth(
        null,
        clientIp,
        'NIP-98',
        'failure',
        'Missing proof event or user pubkey'
      );
      return error(400, 'Missing required fields: proofEvent and userPubkeyHex');
    }

    // Validate pubkey format (should be hex, 64 characters)
    if (typeof userPubkeyHex !== 'string' || !/^[0-9a-f]{64}$/i.test(userPubkeyHex)) {
      auditLogger.logAuth(
        null,
        clientIp,
        'NIP-98',
        'failure',
        'Invalid pubkey format'
      );
      return error(400, 'Invalid pubkey format');
    }

    // Validate proof event structure
    if (!proofEvent.kind || !proofEvent.pubkey || !proofEvent.created_at || !proofEvent.id) {
      auditLogger.logAuth(
        userPubkeyHex,
        clientIp,
        'NIP-98',
        'failure',
        'Invalid proof event structure'
      );
      return error(400, 'Invalid proof event structure');
    }

    // Validate proof event signature first (even if using cache, user must prove they have private key)
    if (!verifyEvent(proofEvent)) {
      auditLogger.logAuth(
        userPubkeyHex,
        clientIp,
        'NIP-98',
        'failure',
        'Invalid proof event signature'
      );
      return error(400, 'Invalid proof event signature');
    }

    // Verify pubkey matches
    if (proofEvent.pubkey !== userPubkeyHex) {
      auditLogger.logAuth(
        userPubkeyHex,
        clientIp,
        'NIP-98',
        'failure',
        'Proof event pubkey does not match user pubkey'
      );
      return error(400, 'Proof event pubkey does not match user pubkey');
    }

    // Check cache (if relays are down, use cached value)
    // But user must still provide valid proof event signed with their private key
    const cached = getCachedUserLevel(userPubkeyHex);
    if (cached) {
      logger.info({ userPubkeyHex, level: cached.level }, '[API] Using cached user level (proof event signature validated)');
      return json({
        level: cached.level,
        verified: true,
        cached: true
        // SECURITY: Removed userPubkeyHex - client already knows their own pubkey
      });
    }

    // Verify relay write proof server-side
    const verification = await verifyRelayWriteProof(
      proofEvent,
      userPubkeyHex,
      DEFAULT_NOSTR_RELAYS
    );

    // If relays are down, check cache again (might have been cached from previous request)
    if (verification.relayDown) {
      const cachedOnRelayDown = getCachedUserLevel(userPubkeyHex);
      if (cachedOnRelayDown) {
        logger.info({ userPubkeyHex, level: cachedOnRelayDown.level }, '[API] Relays down, using cached user level');
        auditLogger.logAuth(
          userPubkeyHex,
          clientIp,
          'NIP-98',
          'success',
          'Relays down, using cached access level'
        );
        return json({
          level: cachedOnRelayDown.level,
          verified: true,
          cached: true,
          relayDown: true
          // SECURITY: Removed userPubkeyHex - client already knows their own pubkey
        });
      }
      
      // No cache available and relays are down - return error
      auditLogger.logAuth(
        userPubkeyHex,
        clientIp,
        'NIP-98',
        'failure',
        'Relays unavailable and no cached access level'
      );
      return error(503, 'Relays are temporarily unavailable. Please try again later.');
    }

    if (verification.valid) {
      // User has write access - unlimited level
      // Cache the successful verification
      cacheUserLevel(userPubkeyHex, 'unlimited');
      
      auditLogger.logAuth(
        userPubkeyHex,
        clientIp,
        'NIP-98',
        'success',
        'Relay write access verified'
      );
      
      return json({
        level: 'unlimited',
        verified: true
        // SECURITY: Removed userPubkeyHex - client already knows their own pubkey
      });
    } else {
      // User is logged in but no write access - rate limited
      // Cache this level too (so they don't lose access if relays go down)
      cacheUserLevel(userPubkeyHex, 'rate_limited');
      
      auditLogger.logAuth(
        userPubkeyHex,
        clientIp,
        'NIP-98',
        'success',
        'Authenticated but no relay write access'
      );
      
      return json({
        level: 'rate_limited',
        verified: true,
        error: verification.error
        // SECURITY: Removed userPubkeyHex - client already knows their own pubkey
      });
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error({ error: err, clientIp }, '[API] Error verifying user level');
    
    auditLogger.logAuth(
      null,
      clientIp,
      'NIP-98',
      'failure',
      sanitizeError(errorMessage)
    );
    
    return error(500, 'Failed to verify user level');
  }
};
