/**
 * Server-side hooks for gitrepublic-web
 * Initializes repo polling service and security middleware
 */

import type { Handle } from '@sveltejs/kit';
import { error } from '@sveltejs/kit';
import { RepoPollingService } from './lib/services/nostr/repo-polling.js';
import { GIT_DOMAIN, DEFAULT_NOSTR_RELAYS } from './lib/config.js';
import { rateLimiter } from './lib/services/security/rate-limiter.js';
import { auditLogger } from './lib/services/security/audit-logger.js';
import logger from './lib/services/logger.js';

// Initialize polling service
const repoRoot = process.env.GIT_REPO_ROOT || '/repos';
const domain = GIT_DOMAIN;

let pollingService: RepoPollingService | null = null;

if (typeof process !== 'undefined') {
  pollingService = new RepoPollingService(DEFAULT_NOSTR_RELAYS, repoRoot, domain);
  pollingService.start();
  logger.info('Started repo polling service');
}

export const handle: Handle = async ({ event, resolve }) => {
  // Rate limiting
  const clientIp = event.getClientAddress();
  const url = event.url;
  
  // Determine rate limit type based on path
  let rateLimitType = 'api';
  if (url.pathname.startsWith('/api/git/')) {
    rateLimitType = 'git';
  } else if (url.pathname.startsWith('/api/repos/') && url.pathname.includes('/file')) {
    rateLimitType = 'file';
  } else if (url.pathname.startsWith('/api/search')) {
    rateLimitType = 'search';
  }

  // Check rate limit
  const rateLimitResult = rateLimiter.check(rateLimitType, clientIp);
  if (!rateLimitResult.allowed) {
    auditLogger.log({
      ip: clientIp,
      action: `rate_limit.${rateLimitType}`,
      result: 'denied',
      metadata: { path: url.pathname }
    });
    return error(429, `Rate limit exceeded. Try again after ${new Date(rateLimitResult.resetAt).toISOString()}`);
  }

  // Audit log the request (basic info)
  // Detailed audit logging happens in individual endpoints
  const startTime = Date.now();
  
  try {
    const response = await resolve(event);
    
    // Log successful request if it's a security-sensitive operation
    if (url.pathname.startsWith('/api/')) {
      const duration = Date.now() - startTime;
      auditLogger.log({
        ip: clientIp,
        action: `request.${event.request.method.toLowerCase()}`,
        resource: url.pathname,
        result: 'success',
        metadata: { status: response.status, duration }
      });
    }
    
    return response;
  } catch (err) {
    // Log failed request
    auditLogger.log({
      ip: clientIp,
      action: `request.${event.request.method.toLowerCase()}`,
      resource: url.pathname,
      result: 'failure',
      error: err instanceof Error ? err.message : String(err)
    });
    throw err;
  }
};
