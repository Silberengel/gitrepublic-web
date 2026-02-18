/**
 * API endpoint for deleting local repository clones
 * Only allows deletion by repo owner or admin
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { rm } from 'fs/promises';
import { join, resolve } from 'path';
import { existsSync } from 'fs';
import { createRepoGetHandler } from '$lib/utils/api-handlers.js';
import type { RepoRequestContext } from '$lib/utils/api-context.js';
import { handleApiError, handleAuthorizationError } from '$lib/utils/error-handler.js';
import { auditLogger } from '$lib/services/security/audit-logger.js';
import { nip19 } from 'nostr-tools';
import logger from '$lib/services/logger.js';
import { repoCache, RepoCache } from '$lib/services/git/repo-cache.js';

const repoRoot = typeof process !== 'undefined' && process.env?.GIT_REPO_ROOT
  ? process.env.GIT_REPO_ROOT
  : '/repos';

// Admin pubkeys (can be set via environment variable)
const ADMIN_PUBKEYS = (typeof process !== 'undefined' && process.env?.ADMIN_PUBKEYS
  ? process.env.ADMIN_PUBKEYS.split(',').map(p => p.trim()).filter(p => p.length > 0)
  : []) as string[];

/**
 * Check if user is admin
 */
function isAdmin(userPubkeyHex: string | null): boolean {
  if (!userPubkeyHex) return false;
  return ADMIN_PUBKEYS.some(adminPubkey => {
    // Support both hex and npub formats
    try {
      const decoded = nip19.decode(adminPubkey);
      if (decoded.type === 'npub') {
        return decoded.data === userPubkeyHex;
      }
    } catch {
      // Not an npub, compare as hex
    }
    return adminPubkey.toLowerCase() === userPubkeyHex.toLowerCase();
  });
}

/**
 * Check if user is repo owner
 */
function isOwner(userPubkeyHex: string | null, repoOwnerPubkey: string): boolean {
  if (!userPubkeyHex) return false;
  return userPubkeyHex.toLowerCase() === repoOwnerPubkey.toLowerCase();
}

export const DELETE: RequestHandler = createRepoGetHandler(
  async (context: RepoRequestContext, event) => {
    const { npub, repo, repoOwnerPubkey, userPubkeyHex, clientIp } = context;
    
    // Check permissions: must be owner or admin
    if (!userPubkeyHex) {
      auditLogger.log({
        user: undefined,
        ip: clientIp,
        action: 'repo.delete',
        resource: `${npub}/${repo}`,
        result: 'denied',
        error: 'Authentication required'
      });
      return handleAuthorizationError('Authentication required to delete repositories');
    }
    
    const userIsOwner = isOwner(userPubkeyHex, repoOwnerPubkey);
    const userIsAdmin = isAdmin(userPubkeyHex);
    
    if (!userIsOwner && !userIsAdmin) {
      auditLogger.log({
        user: userPubkeyHex,
        ip: clientIp,
        action: 'repo.delete',
        resource: `${npub}/${repo}`,
        result: 'denied',
        error: 'Insufficient permissions'
      });
      return handleAuthorizationError('Only repository owners or admins can delete repositories');
    }
    
    // Get repository path
    const repoPath = join(repoRoot, npub, `${repo}.git`);
    
    // Security: Ensure resolved path is within repoRoot
    const resolvedPath = resolve(repoPath).replace(/\\/g, '/');
    const resolvedRoot = resolve(repoRoot).replace(/\\/g, '/');
    if (!resolvedPath.startsWith(resolvedRoot + '/')) {
      auditLogger.log({
        user: userPubkeyHex,
        ip: clientIp,
        action: 'repo.delete',
        resource: `${npub}/${repo}`,
        result: 'denied',
        error: 'Invalid repository path'
      });
      return error(403, 'Invalid repository path');
    }
    
    // Check if repo exists
    if (!existsSync(repoPath)) {
      auditLogger.log({
        user: userPubkeyHex,
        ip: clientIp,
        action: 'repo.delete',
        resource: `${npub}/${repo}`,
        result: 'failure',
        error: 'Repository not found'
      });
      return error(404, 'Repository not found');
    }
    
    try {
      // Delete the repository directory
      await rm(repoPath, { recursive: true, force: true });
      
      // Clear cache
      repoCache.delete(RepoCache.repoExistsKey(npub, repo));
      
      // Log successful deletion
      auditLogger.log({
        user: userPubkeyHex,
        ip: clientIp,
        action: 'repo.delete',
        resource: `${npub}/${repo}`,
        result: 'success',
        metadata: {
          isOwner: userIsOwner,
          isAdmin: userIsAdmin
        }
      });
      
      logger.info({ 
        user: userPubkeyHex, 
        npub, 
        repo,
        isOwner: userIsOwner,
        isAdmin: userIsAdmin
      }, 'Repository deleted');
      
      return json({ 
        success: true, 
        message: 'Repository deleted successfully' 
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      
      auditLogger.log({
        user: userPubkeyHex,
        ip: clientIp,
        action: 'repo.delete',
        resource: `${npub}/${repo}`,
        result: 'failure',
        error: errorMessage
      });
      
      return handleApiError(err, { operation: 'deleteRepo', npub, repo }, 'Failed to delete repository');
    }
  },
  { 
    operation: 'deleteRepo',
    requireRepoExists: true,
    requireRepoAccess: false, // We check permissions manually
    requireMaintainer: false // We check owner/admin manually
  }
);
