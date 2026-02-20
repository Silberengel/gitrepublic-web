/**
 * API endpoint for getting messaging preferences summary
 * Returns safe summary without sensitive tokens
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getCachedUserLevel } from '$lib/services/security/user-level-cache.js';
import { hasUnlimitedAccess } from '$lib/utils/user-access.js';
import { extractRequestContext } from '$lib/utils/api-context.js';
import logger from '$lib/services/logger.js';

/**
 * GET - Get messaging preferences summary (safe, no tokens)
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

    // Preferences are now stored client-side in IndexedDB
    // The client should read from IndexedDB directly using preferences-storage.client.ts
    // This endpoint returns a default response indicating client-side storage
    
    return json({
      configured: false, // Client should check IndexedDB
      enabled: false,
      platforms: {},
      message: 'Preferences are stored client-side in IndexedDB. Use preferences-storage.client.ts to access them.'
    });
  } catch (err) {
    logger.error({ error: err, clientIp }, '[API] Error getting messaging preferences summary');
    
    // If rate limit exceeded, return configured but no details
    if (err instanceof Error && err.message.includes('rate limit')) {
      return json({
        configured: true,
        enabled: false,
        platforms: {},
        error: 'Rate limit exceeded'
      });
    }
    
    // If messaging is not configured, return not configured
    if (err instanceof Error && (
      err.message.includes('not configured') || 
      err.message.includes('environment variable') ||
      err.message.includes('LOOKUP_SECRET')
    )) {
      return json({
        configured: false,
        enabled: false,
        platforms: {}
      });
    }
    
    // For any other error, return not configured (graceful degradation)
    return json({
      configured: false,
      enabled: false,
      platforms: {}
    });
  }
};
