/**
 * API Context Utilities
 * Extract and validate common request context from SvelteKit requests
 */

import type { RequestEvent } from '@sveltejs/kit';
import { requireNpubHex, decodeNpubToHex } from './npub-utils.js';

// Re-export RequestEvent for convenience
export type { RequestEvent };

/**
 * Extracted request context
 */
export interface RequestContext {
  userPubkey: string | null;
  userPubkeyHex: string | null;
  clientIp: string;
  ref?: string;
  path?: string;
  branch?: string;
  limit?: number;
  [key: string]: unknown;
}

/**
 * Repository context with validated parameters
 */
export interface RepoContext {
  npub: string;
  repo: string;
  repoOwnerPubkey: string;
}

/**
 * Combined context for repository operations
 */
export interface RepoRequestContext extends RequestContext, RepoContext {}

/**
 * Extract common request context from a SvelteKit request
 * 
 * @param event - SvelteKit request event
 * @param url - URL object (can be extracted from event.url)
 * @returns Extracted request context
 */
export function extractRequestContext(
  event: RequestEvent,
  url?: URL
): RequestContext {
  const requestUrl = url || event.url;
  
  // Extract user pubkey from query params or headers (support both lowercase and capitalized)
  const userPubkey = requestUrl.searchParams.get('userPubkey') || 
                     event.request.headers.get('X-User-Pubkey') ||
                     event.request.headers.get('x-user-pubkey') || 
                     null;
  
  // Debug logging
  if (userPubkey) {
    console.debug('[API Context] Extracted userPubkey from request:', userPubkey.substring(0, 16) + '...');
  } else {
    console.debug('[API Context] No userPubkey found in request headers or query params');
    // Log all headers for debugging
    const allHeaders: Record<string, string> = {};
    event.request.headers.forEach((value, key) => {
      allHeaders[key] = value;
    });
    console.debug('[API Context] Request headers:', allHeaders);
  }
  
  // Convert to hex if needed
  const userPubkeyHex = userPubkey ? (decodeNpubToHex(userPubkey) || userPubkey) : null;
  
  if (userPubkeyHex) {
    console.debug('[API Context] Converted to hex:', userPubkeyHex.substring(0, 16) + '...');
  }
  
  // Extract client IP
  let clientIp: string;
  try {
    clientIp = event.getClientAddress();
  } catch {
    // Fallback for internal Vite dev server requests or when client address can't be determined
    clientIp = event.request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 
               event.request.headers.get('x-real-ip') || 
               '127.0.0.1';
  }
  
  // Extract common query parameters
  const ref = requestUrl.searchParams.get('ref') || undefined;
  const path = requestUrl.searchParams.get('path') || undefined;
  const branch = requestUrl.searchParams.get('branch') || undefined;
  const limit = requestUrl.searchParams.get('limit') 
    ? parseInt(requestUrl.searchParams.get('limit')!, 10) 
    : undefined;
  
  return {
    userPubkey,
    userPubkeyHex,
    clientIp,
    ref,
    path,
    branch,
    limit
  };
}

/**
 * Validate and extract repository context from route parameters
 * 
 * @param params - Route parameters (from SvelteKit)
 * @returns Validated repository context
 * @throws Error if validation fails
 */
export function validateRepoParams(params: { npub?: string; repo?: string }): RepoContext {
  const { npub, repo } = params;
  
  if (!npub || !repo) {
    throw new Error('Missing npub or repo parameter');
  }
  
  // Validate and convert npub to pubkey
  let repoOwnerPubkey: string;
  try {
    repoOwnerPubkey = requireNpubHex(npub);
  } catch {
    throw new Error(`Invalid npub format: ${npub}`);
  }
  
  return {
    npub,
    repo,
    repoOwnerPubkey
  };
}

/**
 * Get combined repository and request context
 * Combines parameter validation with request context extraction
 * 
 * @param event - SvelteKit request event
 * @param params - Route parameters
 * @returns Combined repository and request context
 */
export function getRepoContext(
  event: RequestEvent,
  params: { npub?: string; repo?: string }
): RepoRequestContext {
  const requestContext = extractRequestContext(event);
  const repoContext = validateRepoParams(params);
  
  return {
    ...requestContext,
    ...repoContext
  };
}

/**
 * Extract user pubkey from request (convenience function)
 */
export function getUserPubkey(event: RequestEvent): string | null {
  const url = event.url;
  return url.searchParams.get('userPubkey') || 
         event.request.headers.get('x-user-pubkey') || 
         null;
}

/**
 * Extract client IP from request (convenience function)
 */
export function getClientIp(event: RequestEvent): string {
  try {
    return event.getClientAddress();
  } catch {
    return event.request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 
           event.request.headers.get('x-real-ip') || 
           '127.0.0.1';
  }
}
