/**
 * Git Dashboard API
 * 
 * Aggregates issues and pull requests from external git platforms
 * for display in the universal dashboard.
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { extractRequestContext } from '$lib/utils/api-context.js';
import { getAllExternalItems } from '$lib/services/git-platforms/git-platform-fetcher.js';
import { getCachedUserLevel } from '$lib/services/security/user-level-cache.js';
import { hasUnlimitedAccess } from '$lib/utils/user-access.js';
import logger from '$lib/services/logger.js';

/**
 * GET /api/user/git-dashboard
 * Get aggregated issues and PRs from all configured git platforms
 */
export const GET: RequestHandler = async (event) => {
  const requestContext = extractRequestContext(event);
  const clientIp = requestContext.clientIp || 'unknown';

  try {
    if (!requestContext.userPubkeyHex) {
      return error(401, 'Authentication required');
    }

    // Check user has unlimited access (same requirement as messaging forwarding)
    const userLevel = getCachedUserLevel(requestContext.userPubkeyHex);
    if (!hasUnlimitedAccess(userLevel?.level)) {
      return json({
        issues: [],
        pullRequests: [],
        message: 'Git dashboard requires unlimited access. Please verify you can write to at least one default Nostr relay.'
      });
    }

    const { issues, pullRequests } = await getAllExternalItems(requestContext.userPubkeyHex);

    logger.debug({
      userPubkey: requestContext.userPubkeyHex.slice(0, 16) + '...',
      issuesCount: issues.length,
      prsCount: pullRequests.length,
      clientIp
    }, 'Fetched git dashboard data');

    return json({
      issues,
      pullRequests
    });
  } catch (e) {
    logger.error({ error: e, clientIp }, 'Failed to fetch git dashboard data');
    return error(500, 'Failed to fetch git dashboard data');
  }
};
