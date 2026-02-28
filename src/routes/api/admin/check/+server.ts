/**
 * API endpoint to check if current user is admin
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { extractRequestContext } from '$lib/utils/api-context.js';
import { isAdmin } from '$lib/utils/admin-check.js';
import { nip19 } from 'nostr-tools';
import logger from '$lib/services/logger.js';

export const GET: RequestHandler = async (event) => {
  const requestContext = extractRequestContext(event);
  let userPubkeyHex = requestContext.userPubkeyHex;
  
  // If we don't have hex, try to get from header and decode if it's an npub
  if (!userPubkeyHex) {
    const userPubkey = event.request.headers.get('X-User-Pubkey') || 
                       event.request.headers.get('x-user-pubkey');
    
    if (userPubkey) {
      // Check if it's already hex
      if (/^[0-9a-f]{64}$/i.test(userPubkey)) {
        userPubkeyHex = userPubkey.toLowerCase();
      } else {
        // Try to decode as npub
        try {
          const decoded = nip19.decode(userPubkey);
          if (decoded.type === 'npub') {
            userPubkeyHex = decoded.data as string;
          }
        } catch (err) {
          logger.debug({ error: err, userPubkey }, 'Failed to decode user pubkey as npub');
        }
      }
    }
  }
  
  if (!userPubkeyHex) {
    return json({ isAdmin: false });
  }
  
  const adminStatus = isAdmin(userPubkeyHex);
  logger.debug({ userPubkeyHex: userPubkeyHex.substring(0, 16) + '...', isAdmin: adminStatus }, 'Admin check result');
  
  return json({ isAdmin: adminStatus });
};
