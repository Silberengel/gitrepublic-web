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
  // Handle unhandled promise rejections to prevent crashes from relay errors
  process.on('unhandledRejection', (reason, promise) => {
    // Log the error but don't crash - relay errors (like payment requirements) are expected
    if (reason instanceof Error && reason.message.includes('restricted')) {
      logger.debug({ error: reason.message }, 'Relay access restricted (expected for paid relays)');
    } else {
      logger.warn({ error: reason, promise }, 'Unhandled promise rejection (non-fatal)');
    }
  });

  pollingService = new RepoPollingService(DEFAULT_NOSTR_RELAYS, repoRoot, domain);
  
  // Start polling - the initial poll will complete asynchronously
  // The local repos endpoint will skip cache for the first 10 seconds after startup
  pollingService.start().then(() => {
    logger.info({ service: 'repo-polling', relays: DEFAULT_NOSTR_RELAYS.length }, 'Repo polling service ready (initial poll completed)');
  }).catch((err) => {
    logger.error({ error: err, service: 'repo-polling' }, 'Initial repo poll failed, but continuing');
  });
  
  logger.info({ service: 'repo-polling', relays: DEFAULT_NOSTR_RELAYS.length }, 'Started repo polling service (initial poll in progress)');

  // Cleanup on server shutdown
  const cleanup = (signal: string) => {
    logger.info({ signal }, 'Received shutdown signal, cleaning up...');
    if (pollingService) {
      logger.info('Stopping repo polling service...');
      pollingService.stop();
      pollingService = null;
    }
    // Give a moment for cleanup, then exit
    setTimeout(() => {
      process.exit(0);
    }, 1000);
  };

  process.on('SIGTERM', () => cleanup('SIGTERM'));
  process.on('SIGINT', () => {
    // SIGINT (Ctrl-C) - exit immediately after cleanup
    cleanup('SIGINT');
    // Force exit after 2 seconds if cleanup takes too long
    setTimeout(() => {
      logger.warn('Forcing exit after SIGINT');
      process.exit(0);
    }, 2000);
  });
  
  // Also cleanup on process exit (last resort)
  process.on('exit', () => {
    if (pollingService) {
      pollingService.stop();
    }
  });

  // Periodic zombie process cleanup check
  // This helps catch any processes that weren't properly cleaned up
  if (typeof setInterval !== 'undefined') {
    setInterval(() => {
      // Check for zombie processes by attempting to reap them
      // Node.js handles this automatically via 'close' events, but this is a safety net
      // We can't directly check for zombies, but we can ensure our cleanup is working
      // The real cleanup happens in process handlers, this is just monitoring
      logger.debug('Zombie cleanup check (process handlers should prevent zombies)');
    }, 60000); // Check every minute
  }
}

export const handle: Handle = async ({ event, resolve }) => {
  // Get client IP, with fallback for dev/internal requests
  let clientIp: string;
  try {
    clientIp = event.getClientAddress();
  } catch {
    // Fallback for internal Vite dev server requests or when client address can't be determined
    clientIp = event.request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 
               event.request.headers.get('x-real-ip') || 
               '127.0.0.1';
  }
  
  const url = event.url;
  
  // Skip rate limiting for Vite internal requests in dev mode
  const isViteInternalRequest = url.pathname.startsWith('/@') || 
                                 url.pathname.startsWith('/src/') ||
                                 url.pathname.startsWith('/node_modules/') ||
                                 url.pathname.includes('react-refresh') ||
                                 url.pathname.includes('vite-plugin-pwa');
  
  // Determine rate limit type based on path
  let rateLimitType = 'api';
  if (url.pathname.startsWith('/api/git/')) {
    rateLimitType = 'git';
  } else if (url.pathname.startsWith('/api/repos/') && url.pathname.includes('/file')) {
    rateLimitType = 'file';
  } else if (url.pathname.startsWith('/api/search')) {
    rateLimitType = 'search';
  }
  
  // Extract user pubkey for rate limiting (authenticated users get higher limits)
  const userPubkey = event.request.headers.get('X-User-Pubkey') || 
                     event.request.headers.get('x-user-pubkey') ||
                     url.searchParams.get('userPubkey') || 
                     null;
  
  // Use user pubkey as identifier if authenticated, otherwise use IP
  // This allows authenticated users to have per-user limits (can't bypass by changing IP)
  // and anonymous users are limited by IP (prevents abuse)
  const rateLimitIdentifier = userPubkey ? `user:${userPubkey}` : `ip:${clientIp}`;
  const isAnonymous = !userPubkey;

  // Skip rate limiting for read-only GET requests to repo endpoints (page loads)
  // These are necessary for normal page functionality and are not write operations
  const isReadOnlyRepoRequest = event.request.method === 'GET' && 
                                 url.pathname.startsWith('/api/repos/') &&
                                 !url.pathname.includes('/file') && // File operations are rate limited separately
                                 !url.pathname.includes('/delete') &&
                                 !url.pathname.includes('/transfer') &&
                                 (url.pathname.endsWith('/fork') || // GET /fork is read-only
                                  url.pathname.endsWith('/verify') || // GET /verify is read-only
                                  url.pathname.endsWith('/readme') || // GET /readme is read-only
                                  url.pathname.endsWith('/branches') || // GET /branches is read-only
                                  url.pathname.endsWith('/tags') || // GET /tags is read-only
                                  url.pathname.endsWith('/tree') || // GET /tree is read-only
                                  url.pathname.endsWith('/commits') || // GET /commits is read-only
                                  url.pathname.endsWith('/access') || // GET /access is read-only
                                  url.pathname.endsWith('/maintainers')); // GET /maintainers is read-only

  // Skip rate limiting for read-only GET requests to user endpoints (profile pages)
  const isReadOnlyUserRequest = event.request.method === 'GET' && 
                                  url.pathname.startsWith('/api/users/') &&
                                  (url.pathname.endsWith('/repos')); // GET /users/[npub]/repos is read-only

  // Check rate limit (skip for Vite internal requests and read-only requests)
  const rateLimitResult = (isViteInternalRequest || isReadOnlyRepoRequest || isReadOnlyUserRequest)
    ? { allowed: true, resetAt: Date.now() }
    : rateLimiter.check(rateLimitType, rateLimitIdentifier, isAnonymous);
  if (!rateLimitResult.allowed) {
    auditLogger.log({
      ip: clientIp,
      action: `rate_limit.${rateLimitType}`,
      result: 'denied',
      metadata: { 
        path: url.pathname,
        identifier: rateLimitIdentifier,
        isAnonymous,
        userPubkey: userPubkey || null
      }
    });
    return error(429, `Rate limit exceeded. Try again after ${new Date(rateLimitResult.resetAt).toISOString()}`);
  }

  // Audit log the request (basic info)
  // Detailed audit logging happens in individual endpoints
  const startTime = Date.now();
  
  try {
    const response = await resolve(event);
    
    // Add security headers
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('X-Frame-Options', 'DENY');
    response.headers.set('X-XSS-Protection', '1; mode=block');
    response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.headers.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    
    // Add CSP header (Content Security Policy)
    // Allow frames from common git hosting platforms for web URL previews
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'", // unsafe-eval needed for Svelte
      "script-src-elem 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "style-src-elem 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "img-src 'self' data: https:",
      "font-src 'self' data: https://fonts.gstatic.com",
      "connect-src 'self' wss: https:",
      "frame-src 'self' https:", // Allow iframes from same origin and HTTPS URLs (for web URL previews)
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'"
    ].join('; ');
    response.headers.set('Content-Security-Policy', csp);
    
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
