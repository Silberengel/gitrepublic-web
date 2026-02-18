/**
 * API Authorization Helpers
 * Reusable authorization functions for API routes
 */

import { error } from '@sveltejs/kit';
import type { NostrEvent } from '../types/nostr.js';
import { verifyNIP98Auth } from '../services/nostr/nip98-auth.js';
import { maintainerService } from '../services/service-registry.js';
import { fileManager } from '../services/service-registry.js';
import type { RepoContext, RequestContext, RepoRequestContext } from './api-context.js';
import { handleValidationError, handleAuthError, handleAuthorizationError, handleNotFoundError } from './error-handler.js';
import { BookmarksService } from '../services/nostr/bookmarks-service.js';
import { DEFAULT_NOSTR_RELAYS } from '../config.js';
import { KIND } from '../types/nostr.js';

/**
 * Check if user has access to a repository (privacy check)
 * 
 * @param repoContext - Repository context
 * @param requestContext - Request context with user pubkey
 * @param operation - Operation name for error context
 * @returns void if access allowed, throws error if denied
 */
export async function requireRepoAccess(
  repoContext: RepoContext,
  requestContext: RequestContext,
  operation?: string
): Promise<void> {
  console.debug('[API Auth] requireRepoAccess check:', {
    operation,
    userPubkeyHex: requestContext.userPubkeyHex ? requestContext.userPubkeyHex.substring(0, 16) + '...' : null,
    repoOwnerPubkey: repoContext.repoOwnerPubkey.substring(0, 16) + '...',
    repo: repoContext.repo
  });
  
  // First check if user is owner/maintainer (or repo is public)
  const canView = await maintainerService.canView(
    requestContext.userPubkeyHex || null,
    repoContext.repoOwnerPubkey,
    repoContext.repo
  );
  
  console.debug('[API Auth] canView result:', canView);
  
  if (canView) {
    return; // User is owner/maintainer or repo is public, allow access
  }
  
  // canView returned false, which means repo is private and user is not owner/maintainer
  // Check if user has bookmarked the private repo
  if (requestContext.userPubkeyHex) {
    try {
      const bookmarksService = new BookmarksService(DEFAULT_NOSTR_RELAYS);
      const repoAddress = `${KIND.REPO_ANNOUNCEMENT}:${repoContext.repoOwnerPubkey}:${repoContext.repo}`;
      const isBookmarked = await bookmarksService.isBookmarked(requestContext.userPubkeyHex, repoAddress);
      
      if (isBookmarked) {
        return; // User has bookmarked the private repo, allow access
      }
    } catch (err) {
      // If bookmark check fails, continue to deny access
      // Log error but don't expose it to user
      console.error('[API Auth] Error checking bookmarks:', err);
    }
  }
  
  // All checks failed - deny access
  throw handleAuthorizationError(
    'This repository is private. Only owners, maintainers, and users who have bookmarked it can view it.',
    { operation, npub: repoContext.npub, repo: repoContext.repo }
  );
}

/**
 * Check if repository exists
 * 
 * @param repoContext - Repository context
 * @param operation - Operation name for error context
 * @returns void if exists, throws error if not found
 */
export function requireRepoExists(
  repoContext: RepoContext,
  operation?: string
): void {
  if (!fileManager.repoExists(repoContext.npub, repoContext.repo)) {
    throw handleNotFoundError(
      'Repository not found',
      { operation, npub: repoContext.npub, repo: repoContext.repo }
    );
  }
}

/**
 * Check if user is a maintainer of the repository
 * 
 * @param repoContext - Repository context
 * @param requestContext - Request context with user pubkey
 * @param operation - Operation name for error context
 * @returns void if maintainer, throws error if not
 */
export async function requireMaintainer(
  repoContext: RepoContext,
  requestContext: RequestContext,
  operation?: string
): Promise<void> {
  if (!requestContext.userPubkeyHex) {
    throw handleAuthError(
      'Authentication required. Please provide userPubkey.',
      { operation, npub: repoContext.npub, repo: repoContext.repo }
    );
  }
  
  const isMaintainer = await maintainerService.isMaintainer(
    requestContext.userPubkeyHex,
    repoContext.repoOwnerPubkey,
    repoContext.repo
  );
  
  if (!isMaintainer) {
    throw handleAuthorizationError(
      'Only repository maintainers can perform this action. Please submit a pull request instead.',
      { operation, npub: repoContext.npub, repo: repoContext.repo }
    );
  }
}

/**
 * Verify NIP-98 authentication from request headers
 * 
 * @param request - Request object
 * @param url - URL object
 * @param method - HTTP method
 * @param operation - Operation name for error context
 * @returns NIP-98 event if valid, throws error if invalid
 */
export function requireNIP98Auth(
  request: Request,
  url: URL,
  method: string,
  operation?: string
): NostrEvent {
  const authHeader = request.headers.get('Authorization');
  
  if (!authHeader || !authHeader.startsWith('Nostr ')) {
    throw handleAuthError(
      'NIP-98 authentication required',
      { operation }
    );
  }
  
  // Build absolute request URL for NIP-98 validation
  const protocol = request.headers.get('x-forwarded-proto') || 
                   (url.protocol === 'https:' ? 'https' : 'http');
  const host = request.headers.get('host') || url.host;
  const requestUrl = `${protocol}://${host}${url.pathname}${url.search}`;
  
  const authResult = verifyNIP98Auth(authHeader, requestUrl, method);
  
  if (!authResult.valid || !authResult.event) {
    throw handleAuthError(
      authResult.error || 'Invalid NIP-98 authentication',
      { operation }
    );
  }
  
  return authResult.event;
}

/**
 * Combined check: repository exists and user has access
 * 
 * @param repoContext - Repository context
 * @param requestContext - Request context with user pubkey
 * @param operation - Operation name for error context
 * @returns void if all checks pass, throws error if any fail
 */
export async function requireRepoAccessWithExists(
  repoContext: RepoContext,
  requestContext: RequestContext,
  operation?: string
): Promise<void> {
  requireRepoExists(repoContext, operation);
  await requireRepoAccess(repoContext, requestContext, operation);
}
