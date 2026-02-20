/**
 * API endpoint for managing messaging preferences
 * 
 * SECURITY:
 * - Requires unlimited user access level
 * - Verifies signed Nostr event proof
 * - Stores encrypted preferences with multiple security layers
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { verifyEvent } from 'nostr-tools';
import { getCachedUserLevel } from '$lib/services/security/user-level-cache.js';
import { hasUnlimitedAccess } from '$lib/utils/user-access.js';
import { extractRequestContext } from '$lib/utils/api-context.js';
import { auditLogger } from '$lib/services/security/audit-logger.js';
import logger from '$lib/services/logger.js';
import type { MessagingPreferences } from '$lib/services/messaging/preferences-types.js';

/**
 * POST - Save messaging preferences
 * Requires:
 * - Signed Nostr event (kind 30078) as proof
 * - User must have unlimited access level
 */
export const POST: RequestHandler = async (event) => {
  const requestContext = extractRequestContext(event);
  const clientIp = requestContext.clientIp || 'unknown';
  
  try {
    const body = await event.request.json();
    const { preferences, proofEvent } = body;

    // Validate input
    if (!preferences || !proofEvent) {
      auditLogger.log({
        user: requestContext.userPubkeyHex || undefined,
        ip: clientIp,
        action: 'api.saveMessagingPreferences',
        resource: 'messaging_preferences',
        result: 'failure',
        error: 'Missing preferences or proof event'
      });
      return error(400, 'Missing required fields: preferences and proofEvent');
    }

    // Verify proof event signature
    if (!verifyEvent(proofEvent)) {
      auditLogger.log({
        user: requestContext.userPubkeyHex || undefined,
        ip: clientIp,
        action: 'api.saveMessagingPreferences',
        resource: 'messaging_preferences',
        result: 'failure',
        error: 'Invalid proof event signature'
      });
      return error(400, 'Invalid proof event signature');
    }

    const userPubkeyHex = proofEvent.pubkey;

    // Verify it's a valid preferences event (kind 30078, d tag = 'gitrepublic-messaging')
    if (proofEvent.kind !== 30078) {
      auditLogger.log({
        user: userPubkeyHex,
        ip: clientIp,
        action: 'api.saveMessagingPreferences',
        resource: 'messaging_preferences',
        result: 'failure',
        error: 'Invalid event kind'
      });
      return error(400, 'Proof event must be kind 30078');
    }

    const dTag = proofEvent.tags.find(t => t[0] === 'd');
    if (dTag?.[1] !== 'gitrepublic-messaging') {
      auditLogger.log({
        user: userPubkeyHex,
        ip: clientIp,
        action: 'api.saveMessagingPreferences',
        resource: 'messaging_preferences',
        result: 'failure',
        error: 'Invalid event d tag'
      });
      return error(400, 'Proof event must have d tag "gitrepublic-messaging"');
    }

    // Verify user has unlimited access
    const cached = getCachedUserLevel(userPubkeyHex);
    if (!hasUnlimitedAccess(cached?.level)) {
      auditLogger.log({
        user: userPubkeyHex,
        ip: clientIp,
        action: 'api.saveMessagingPreferences',
        resource: 'messaging_preferences',
        result: 'failure',
        error: 'Requires unlimited access'
      });
      return error(403, 'Messaging forwarding requires unlimited access level');
    }

    // Validate preferences structure
    if (typeof preferences.enabled !== 'boolean') {
      return error(400, 'Invalid preferences: enabled must be boolean');
    }

    // Preferences are now stored client-side in IndexedDB via settings store
    // The client should use the preferences-storage.client.ts helper
    // This API endpoint just validates the request
    // Note: For server-side event forwarding, preferences are read from the client's IndexedDB
    // via the request context when available

    auditLogger.log({
      user: userPubkeyHex,
      ip: clientIp,
      action: 'api.saveMessagingPreferences',
      resource: 'messaging_preferences',
      result: 'success'
    });

    return json({ success: true, message: 'Preferences validated. Client should store in IndexedDB.' });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error({ error: err, clientIp }, '[API] Error saving messaging preferences');
    
    auditLogger.log({
      user: requestContext.userPubkeyHex || undefined,
      ip: clientIp,
      action: 'api.saveMessagingPreferences',
      resource: 'messaging_preferences',
      result: 'failure',
      error: errorMessage
    });
    
    if (errorMessage.includes('rate limit')) {
      return error(429, errorMessage);
    }
    
    return error(500, 'Failed to save messaging preferences');
  }
};

/**
 * GET - Retrieve messaging preferences
 * Returns encrypted status only (for UI), not decrypted data
 */
export const GET: RequestHandler = async (event) => {
  const requestContext = extractRequestContext(event);
  const clientIp = requestContext.clientIp || 'unknown';
  
  try {
    if (!requestContext.userPubkeyHex) {
      return error(401, 'Authentication required');
    }

    // Verify user has unlimited access
    const cached = getCachedUserLevel(requestContext.userPubkeyHex);
    if (!hasUnlimitedAccess(cached?.level)) {
      return error(403, 'Messaging forwarding requires unlimited access level');
    }

    // Preferences are stored client-side in IndexedDB
    // The client should check IndexedDB directly using preferences-storage.client.ts
    // This endpoint just confirms the user has access

    return json({
      configured: false, // Client should check IndexedDB
      message: 'Check client-side IndexedDB for preferences'
    });
  } catch (err) {
    logger.error({ error: err, clientIp }, '[API] Error getting messaging preferences status');
    return error(500, 'Failed to get messaging preferences status');
  }
};

/**
 * DELETE - Remove messaging preferences
 */
export const DELETE: RequestHandler = async (event) => {
  const requestContext = extractRequestContext(event);
  const clientIp = requestContext.clientIp || 'unknown';
  
  try {
    if (!requestContext.userPubkeyHex) {
      return error(401, 'Authentication required');
    }

    // Verify user has unlimited access
    const cached = getCachedUserLevel(requestContext.userPubkeyHex);
    if (!hasUnlimitedAccess(cached?.level)) {
      return error(403, 'Messaging forwarding requires unlimited access level');
    }

    // Preferences are stored client-side in IndexedDB
    // The client should delete from IndexedDB using preferences-storage.client.ts
    // This API endpoint just validates the request

    auditLogger.log({
      user: requestContext.userPubkeyHex,
      ip: clientIp,
      action: 'api.deleteMessagingPreferences',
      resource: 'messaging_preferences',
      result: 'success'
    });

    return json({ success: true, message: 'Client should delete from IndexedDB.' });
  } catch (err) {
    logger.error({ error: err, clientIp }, '[API] Error deleting messaging preferences');
    return error(500, 'Failed to delete messaging preferences');
  }
};
