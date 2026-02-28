/**
 * RESTful Repository Resource Endpoint
 * 
 * GET    /api/repos/{npub}/{repo}      # Get repository info (settings, metadata, access, verification)
 * PUT    /api/repos/{npub}/{repo}      # Update repository (replace)
 * PATCH  /api/repos/{npub}/{repo}      # Partial update (settings, description, etc.)
 * DELETE /api/repos/{npub}/{repo}      # Delete repository
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createRepoGetHandler, createRepoPostHandler } from '$lib/utils/api-handlers.js';
import type { RepoRequestContext, RequestEvent } from '$lib/utils/api-context.js';
import { handleValidationError, handleApiError, handleAuthorizationError } from '$lib/utils/error-handler.js';
import { eventCache } from '$lib/services/nostr/event-cache.js';
import { fetchRepoAnnouncementsWithCache, findRepoAnnouncement } from '$lib/utils/nostr-utils.js';
import { nostrClient, maintainerService } from '$lib/services/service-registry.js';
import { getVisibility, getProjectRelays } from '$lib/utils/repo-visibility.js';
import { KIND } from '$lib/types/nostr.js';
import { nip19 } from 'nostr-tools';
import { getPublicKeyWithNIP07, signEventWithNIP07 } from '$lib/services/nostr/nip07-signer.js';
import { DEFAULT_NOSTR_RELAYS, combineRelays } from '$lib/config.js';
import { getUserRelays } from '$lib/services/nostr/user-relays.js';
import { NostrClient } from '$lib/services/nostr/nostr-client.js';
import { DEFAULT_NOSTR_SEARCH_RELAYS } from '$lib/config.js';
import logger from '$lib/services/logger.js';
import { rm } from 'fs/promises';
import { join, resolve } from 'path';
import { existsSync } from 'fs';
import { auditLogger } from '$lib/services/security/audit-logger.js';
import { repoCache, RepoCache } from '$lib/services/git/repo-cache.js';
import { verifyRepositoryOwnership } from '$lib/services/nostr/repo-verification.js';

const repoRoot = typeof process !== 'undefined' && process.env?.GIT_REPO_ROOT
  ? process.env.GIT_REPO_ROOT
  : '/repos';

// Admin pubkeys (can be set via environment variable)
const ADMIN_PUBKEYS = (typeof process !== 'undefined' && process.env?.ADMIN_PUBKEYS
  ? process.env.ADMIN_PUBKEYS.split(',').map(p => p.trim()).filter(p => p.length > 0)
  : []) as string[];

function isAdmin(userPubkeyHex: string | null): boolean {
  if (!userPubkeyHex) return false;
  return ADMIN_PUBKEYS.some(adminPubkey => {
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

function isOwner(userPubkeyHex: string | null, repoOwnerPubkey: string): boolean {
  if (!userPubkeyHex) return false;
  return userPubkeyHex.toLowerCase() === repoOwnerPubkey.toLowerCase();
}

/**
 * GET: Get repository info
 * Query params: ?include=settings,maintainers,access,verification
 */
export const GET: RequestHandler = createRepoGetHandler(
  async (context: RepoRequestContext, event: RequestEvent) => {
    const url = new URL(event.request.url);
    const include = url.searchParams.get('include')?.split(',') || ['settings', 'access'];
    
    // Fetch repository announcement
    const allEvents = await fetchRepoAnnouncementsWithCache(nostrClient, context.repoOwnerPubkey, eventCache);
    const announcement = findRepoAnnouncement(allEvents, context.repo);

    const result: any = {
      npub: context.npub,
      repo: context.repo,
      owner: context.npub
    };

    // Include settings
    if (include.includes('settings') || include.includes('all')) {
      if (announcement) {
        result.description = announcement.tags.find(t => t[0] === 'description')?.[1] || '';
        result.visibility = getVisibility(announcement);
        result.projectRelays = getProjectRelays(announcement);
        result.private = result.visibility === 'restricted' || result.visibility === 'private';
      } else {
        result.description = '';
        result.visibility = 'public';
        result.projectRelays = [];
        result.private = false;
      }
    }

    // Include maintainers
    if (include.includes('maintainers') || include.includes('all')) {
      const { maintainers, owner } = await maintainerService.getMaintainers(
        context.repoOwnerPubkey,
        context.repo
      );
      result.maintainers = maintainers.map(p => nip19.npubEncode(p));
      result.owner = nip19.npubEncode(owner);
      if (context.userPubkeyHex) {
        result.isMaintainer = maintainers.includes(context.userPubkeyHex);
        result.isOwner = context.userPubkeyHex === owner;
      }
    }

    // Include access
    if (include.includes('access') || include.includes('all')) {
      const { isPrivate, maintainers, owner } = await maintainerService.getMaintainers(
        context.repoOwnerPubkey,
        context.repo
      );
      const canView = await maintainerService.canView(
        context.userPubkeyHex || null,
        context.repoOwnerPubkey,
        context.repo
      );
      result.access = {
        canView,
        isPrivate,
        isMaintainer: context.userPubkeyHex ? maintainers.includes(context.userPubkeyHex) : false,
        isOwner: context.userPubkeyHex ? context.userPubkeyHex === owner : false
      };
    }

    // Include verification
    if (include.includes('verification') || include.includes('all')) {
      // Simplified verification check - full verification is in /verification endpoint
      const repoPath = join(repoRoot, context.npub, `${context.repo}.git`);
      result.verification = {
        exists: existsSync(repoPath),
        announcementFound: !!announcement
      };
    }

    return json(result);
  },
  { operation: 'getRepo', requireRepoExists: false, requireRepoAccess: false }
);

/**
 * PUT: Replace repository (full update)
 * PATCH: Partial update
 */
export const PUT: RequestHandler = createRepoPostHandler(
  async (context: RepoRequestContext, event: RequestEvent) => {
    return updateRepository(context, event, true); // full update
  },
  { operation: 'updateRepo', requireRepoExists: false }
);

export const PATCH: RequestHandler = createRepoPostHandler(
  async (context: RepoRequestContext, event: RequestEvent) => {
    return updateRepository(context, event, false); // partial update
  },
  { operation: 'updateRepo', requireRepoExists: false }
);

async function updateRepository(
  context: RepoRequestContext,
  event: RequestEvent,
  isFullUpdate: boolean
) {
  let body: { 
    description?: string; 
    visibility?: string; 
    projectRelays?: string[]; 
    private?: boolean;
    branchProtection?: any;
  };
  try {
    body = await event.request.json();
  } catch {
    throw handleValidationError('Invalid JSON in request body', { 
      operation: 'updateRepo', 
      npub: context.npub, 
      repo: context.repo 
    });
  }

  // Fetch current announcement
  const allEvents = await fetchRepoAnnouncementsWithCache(nostrClient, context.repoOwnerPubkey, eventCache);
  const announcement = findRepoAnnouncement(allEvents, context.repo);

  if (!announcement) {
    throw handleValidationError('Repository announcement not found', { 
      operation: 'updateRepo', 
      npub: context.npub, 
      repo: context.repo 
    });
  }

  // Get user's pubkey (required for signing)
  const userPubkey = await getPublicKeyWithNIP07();
  let userPubkeyHex: string;
  if (typeof userPubkey === 'string' && userPubkey.length === 64) {
    userPubkeyHex = userPubkey;
  } else {
    const decoded = nip19.decode(userPubkey) as { type: string; data: unknown };
    if (decoded.type === 'npub' && typeof decoded.data === 'string') {
      userPubkeyHex = decoded.data;
    } else {
      throw handleValidationError('Invalid user pubkey format', { operation: 'updateRepo', npub: context.npub, repo: context.repo });
    }
  }

  // Verify user is maintainer
  const isMaintainer = await maintainerService.isMaintainer(userPubkeyHex, context.repoOwnerPubkey, context.repo);
  if (!isMaintainer) {
    return error(403, 'Only maintainers can update repository');
  }

  // Build updated tags
  const tags: string[][] = isFullUpdate ? [] : [...announcement.tags];

  // Update description
  if (body.description !== undefined || isFullUpdate) {
    const descIndex = tags.findIndex(t => t[0] === 'description');
    const descValue = body.description !== undefined ? body.description : (isFullUpdate ? '' : announcement.tags.find(t => t[0] === 'description')?.[1] || '');
    if (descIndex >= 0) {
      tags[descIndex] = ['description', descValue];
    } else if (descValue) {
      tags.push(['description', descValue]);
    }
  }

  // Update visibility
  let newVisibility: 'public' | 'unlisted' | 'restricted' | 'private' = getVisibility(announcement);
  if (body.visibility !== undefined) {
    const vis = body.visibility.toLowerCase();
    if (['public', 'unlisted', 'restricted', 'private'].includes(vis)) {
      newVisibility = vis as typeof newVisibility;
    } else {
      throw handleValidationError(`Invalid visibility: ${body.visibility}. Must be one of: public, unlisted, restricted, private`, 
        { operation: 'updateRepo', npub: context.npub, repo: context.repo });
    }
  } else if (body.private !== undefined) {
    newVisibility = body.private ? 'restricted' : 'public';
  } else if (isFullUpdate) {
    newVisibility = 'public';
  }

  // Update visibility tag
  const visIndex = tags.findIndex(t => t[0] === 'visibility');
  if (newVisibility === 'public') {
    if (visIndex >= 0) {
      tags.splice(visIndex, 1);
    }
  } else {
    if (visIndex >= 0) {
      tags[visIndex] = ['visibility', newVisibility];
    } else {
      tags.push(['visibility', newVisibility]);
    }
  }

  // Update project-relay tags
  if (body.projectRelays !== undefined || isFullUpdate) {
    // Remove existing project-relay tags
    const projectRelayIndices: number[] = [];
    tags.forEach((tag, index) => {
      if (tag[0] === 'project-relay') {
        projectRelayIndices.push(index);
      }
    });
    for (let i = projectRelayIndices.length - 1; i >= 0; i--) {
      tags.splice(projectRelayIndices[i], 1);
    }
    // Add new project-relay tags
    const relays = body.projectRelays || (isFullUpdate ? [] : getProjectRelays(announcement));
    for (const relay of relays) {
      if (relay && (relay.startsWith('ws://') || relay.startsWith('wss://'))) {
        tags.push(['project-relay', relay]);
      }
    }
  }

  // Validate: unlisted/restricted require project-relay
  if ((newVisibility === 'unlisted' || newVisibility === 'restricted')) {
    const hasProjectRelay = tags.some(t => t[0] === 'project-relay');
    if (!hasProjectRelay) {
      throw handleValidationError(
        `Visibility '${newVisibility}' requires at least one project-relay. Please provide project-relays in the request.`,
        { operation: 'updateRepo', npub: context.npub, repo: context.repo }
      );
    }
  }

  // Preserve essential tags
  if (!isFullUpdate) {
    // Keep d-tag, name, clone tags, etc.
    const essentialTags = ['d', 'name', 'clone'];
    essentialTags.forEach(tagName => {
      announcement.tags.forEach(tag => {
        if (tag[0] === tagName && !tags.some(t => t[0] === tagName && t[1] === tag[1])) {
          tags.push(tag);
        }
      });
    });
  } else {
    // For full update, we need d-tag at minimum
    const dTag = announcement.tags.find(t => t[0] === 'd');
    if (dTag) {
      tags.unshift(dTag);
    }
  }

  // Remove old private tag if present
  const privateIndex = tags.findIndex(t => (t[0] === 'private' && t[1] === 'true') || (t[0] === 't' && t[1] === 'private'));
  if (privateIndex >= 0) {
    tags.splice(privateIndex, 1);
  }

  // Create updated event
  const updatedEvent = {
    kind: KIND.REPO_ANNOUNCEMENT,
    pubkey: userPubkeyHex,
    created_at: Math.floor(Date.now() / 1000),
    content: announcement.content || '',
    tags
  };

  // Sign with NIP-07
  const signedEvent = await signEventWithNIP07(updatedEvent);

  // Get user's relays for publishing
  const allSearchRelays = Array.from(new Set([...DEFAULT_NOSTR_SEARCH_RELAYS, ...DEFAULT_NOSTR_RELAYS]));
  const fullRelayClient = new NostrClient(allSearchRelays);
  
  let userRelays: string[] = [];
  try {
    const { inbox, outbox } = await getUserRelays(userPubkeyHex, fullRelayClient);
    if (outbox.length > 0) {
      userRelays = combineRelays(outbox, DEFAULT_NOSTR_RELAYS);
    } else if (inbox.length > 0) {
      userRelays = combineRelays(inbox, DEFAULT_NOSTR_RELAYS);
    } else {
      userRelays = DEFAULT_NOSTR_RELAYS;
    }
  } catch (err) {
    logger.warn({ error: err }, 'Failed to fetch user relays, using defaults');
    userRelays = DEFAULT_NOSTR_RELAYS;
  }

  // Determine which relays to publish to based on visibility
  const { getRelaysForEventPublishing } = await import('$lib/utils/repo-visibility.js');
  const visibilityRelays = getRelaysForEventPublishing(signedEvent);
  const relaysToPublish = visibilityRelays.length > 0 ? combineRelays([...visibilityRelays, ...userRelays]) : [];

  // Publish to relays (if not private)
  if (relaysToPublish.length > 0) {
    const publishResult = await nostrClient.publishEvent(signedEvent, relaysToPublish);
    if (publishResult.failed.length > 0 && publishResult.success.length === 0) {
      logger.warn({ npub: context.npub, repo: context.repo }, 'Failed to publish update to all relays');
    }
  }

  // Save to repository
  const { AnnouncementManager } = await import('$lib/services/git/announcement-manager.js');
  const repoPath = `${repoRoot}/${context.npub}/${context.repo}.git`;
  const announcementManager = new AnnouncementManager(repoRoot);
  try {
    await announcementManager.ensureAnnouncementInRepo(repoPath, signedEvent);
  } catch (err) {
    logger.error({ error: err, npub: context.npub, repo: context.repo }, 'Failed to save update to repository');
  }

  // Return updated repository
  return json({
    npub: context.npub,
    repo: context.repo,
    owner: context.npub,
    description: body.description !== undefined ? body.description : (announcement.tags.find(t => t[0] === 'description')?.[1] || ''),
    visibility: newVisibility,
    projectRelays: body.projectRelays !== undefined ? body.projectRelays : getProjectRelays(announcement),
    private: newVisibility === 'restricted' || newVisibility === 'private'
  });
}

/**
 * DELETE: Delete repository
 */
export const DELETE: RequestHandler = createRepoGetHandler(
  async (context: RepoRequestContext, event: RequestEvent) => {
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
    requireRepoAccess: false,
    requireMaintainer: false
  }
);
