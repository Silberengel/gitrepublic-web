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
  logger.info({ service: 'repo-polling', relays: DEFAULT_NOSTR_RELAYS.length }, 'Started repo polling service');
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

  // Check rate limit (skip for Vite internal requests)
  const rateLimitResult = isViteInternalRequest 
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
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
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
