/**
 * API endpoint for manually triggering a repo poll
 * This allows users to refresh the repo list and trigger provisioning of new repos
 * 
 * This is the public API interface for triggering polls.
 * All poll triggers should go through this endpoint or the shared triggerRepoPoll utility.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { triggerRepoPoll } from '$lib/utils/repo-poll-trigger.js';
import { extractRequestContext } from '$lib/utils/api-context.js';

export const POST: RequestHandler = async (event) => {
  const requestContext = extractRequestContext(event);
  const clientIp = requestContext.clientIp || 'unknown';
  
  try {
    await triggerRepoPoll('api-endpoint');
    
    return json({ 
      success: true,
      message: 'Poll triggered successfully'
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    
    return json({ 
      success: false, 
      error: errorMessage 
    }, { status: err instanceof Error && errorMessage.includes('not available') ? 503 : 500 });
  }
};
