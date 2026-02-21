/**
 * Clone repository endpoint
 * Only privileged users (unlimited access) can clone repos to the server
 */

import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { RepoManager } from '$lib/services/git/repo-manager.js';
import { requireNpubHex } from '$lib/utils/npub-utils.js';
import { existsSync } from 'fs';
import { join } from 'path';
import { DEFAULT_NOSTR_RELAYS } from '$lib/config.js';
import { NostrClient } from '$lib/services/nostr/nostr-client.js';
import { KIND } from '$lib/types/nostr.js';
import { extractRequestContext } from '$lib/utils/api-context.js';
import { getCachedUserLevel, cacheUserLevel } from '$lib/services/security/user-level-cache.js';
import { hasUnlimitedAccess } from '$lib/utils/user-access.js';
import logger from '$lib/services/logger.js';
import { handleApiError, handleValidationError } from '$lib/utils/error-handler.js';
import { verifyRelayWriteProofFromAuth, verifyRelayWriteProof } from '$lib/services/nostr/relay-write-proof.js';
import { verifyEvent } from 'nostr-tools';
import type { NostrEvent } from '$lib/types/nostr.js';
import { resolve } from 'path';
import { eventCache } from '$lib/services/nostr/event-cache.js';
import { fetchRepoAnnouncementsWithCache, findRepoAnnouncement } from '$lib/utils/nostr-utils.js';

// Resolve GIT_REPO_ROOT to absolute path (handles both relative and absolute paths)
const repoRootEnv = process.env.GIT_REPO_ROOT || '/repos';
const repoRoot = resolve(repoRootEnv);
const repoManager = new RepoManager(repoRoot);
const nostrClient = new NostrClient(DEFAULT_NOSTR_RELAYS);

export const POST: RequestHandler = async (event) => {
  const { npub, repo } = event.params;
  
  if (!npub || !repo) {
    throw handleValidationError('Missing npub or repo parameter', { operation: 'cloneRepo', npub, repo });
  }

  // Extract user context
  const requestContext = extractRequestContext(event);
  const userPubkeyHex = requestContext.userPubkeyHex;

  if (!userPubkeyHex) {
    throw error(401, 'Authentication required. Please log in to clone repositories.');
  }

  // Check if user has unlimited access (check cache first)
  let userLevel = getCachedUserLevel(userPubkeyHex);
  
  logger.debug({ 
    userPubkeyHex: userPubkeyHex.slice(0, 16) + '...',
    cachedLevel: userLevel?.level || 'none',
    hasUnlimitedAccess: userLevel ? hasUnlimitedAccess(userLevel.level) : false
  }, 'Checking user access level for clone operation');
  
  // If cache is empty, try to verify from proof event in body, NIP-98 auth header, or return helpful error
  if (!userLevel || !hasUnlimitedAccess(userLevel.level)) {
    let verification: { valid: boolean; error?: string; relay?: string; relayDown?: boolean } | null = null;
    
    // Try to get proof event from request body first (if content-type is JSON)
    const contentType = event.request.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      try {
        // Clone the request to read body without consuming it (if possible)
        // Note: Request body can only be read once, so we need to be careful
        const bodyText = await event.request.text().catch(() => '');
        if (bodyText) {
          try {
            const body = JSON.parse(bodyText);
            if (body.proofEvent && typeof body.proofEvent === 'object') {
              const proofEvent = body.proofEvent as NostrEvent;
              
              // Validate proof event signature and pubkey
              if (verifyEvent(proofEvent) && proofEvent.pubkey === userPubkeyHex) {
                logger.debug({ userPubkeyHex: userPubkeyHex.slice(0, 16) + '...' }, 'Cache empty or expired, attempting to verify from proof event in request body');
                verification = await verifyRelayWriteProof(proofEvent, userPubkeyHex, DEFAULT_NOSTR_RELAYS);
              } else {
                logger.warn({ userPubkeyHex: userPubkeyHex.slice(0, 16) + '...' }, 'Invalid proof event in request body');
              }
            }
          } catch (parseErr) {
            // Not valid JSON or missing proofEvent - continue to check auth header
            logger.debug({ error: parseErr }, 'Request body is not valid JSON or missing proofEvent');
          }
        }
      } catch (err) {
        // Body reading failed - continue to check auth header
        logger.debug({ error: err }, 'Failed to read request body, checking auth header');
      }
    }
    
    // If no proof event in body, try NIP-98 auth header
    if (!verification) {
      const authHeader = event.request.headers.get('authorization') || event.request.headers.get('Authorization');
      
      if (authHeader) {
        logger.debug({ userPubkeyHex: userPubkeyHex.slice(0, 16) + '...' }, 'Cache empty or expired, attempting to verify from NIP-98 auth header');
        verification = await verifyRelayWriteProofFromAuth(authHeader, userPubkeyHex, DEFAULT_NOSTR_RELAYS);
      }
    }
    
    // Process verification result
    if (verification) {
      try {
        if (verification.valid) {
          // User has write access - cache unlimited level
          cacheUserLevel(userPubkeyHex, 'unlimited');
          logger.info({ userPubkeyHex: userPubkeyHex.slice(0, 16) + '...' }, 'Verified unlimited access from proof event');
          userLevel = getCachedUserLevel(userPubkeyHex); // Get the cached value
        } else {
          // Check if relays are down
          if (verification.relayDown) {
            // Relays are down - check cache again (might have been cached from previous request)
            userLevel = getCachedUserLevel(userPubkeyHex);
            if (!userLevel || !hasUnlimitedAccess(userLevel.level)) {
              logger.warn({ userPubkeyHex: userPubkeyHex.slice(0, 16) + '...', error: verification.error }, 'Relays down and no cached unlimited access');
              throw error(503, 'Relays are temporarily unavailable and no cached access level found. Please verify your access level first by visiting your profile page.');
            }
          } else {
            // Verification failed - user doesn't have write access
            logger.warn({ userPubkeyHex: userPubkeyHex.slice(0, 16) + '...', error: verification.error }, 'User does not have unlimited access');
            throw error(403, `Only users with unlimited access can clone repositories to the server. ${verification.error || 'Please verify you can write to at least one default Nostr relay.'}`);
          }
        }
      } catch (err) {
        // If it's already an error response, re-throw it
        if (err && typeof err === 'object' && 'status' in err) {
          throw err;
        }
        logger.error({ error: err, userPubkeyHex: userPubkeyHex.slice(0, 16) + '...' }, 'Error verifying user level');
        // Fall through to check cache one more time
        userLevel = getCachedUserLevel(userPubkeyHex);
      }
    } else {
      // No proof event or auth header - check if we have any cached level
      if (!userLevel) {
        logger.warn({ userPubkeyHex: userPubkeyHex.slice(0, 16) + '...' }, 'No cached user level and no proof event or NIP-98 auth header');
        throw error(403, 'Only users with unlimited access can clone repositories to the server. Please verify your access level first by visiting your profile page or ensuring you can write to at least one default Nostr relay.');
      }
    }
  }
  
  // Final check - user must have unlimited access
  if (!userLevel || !hasUnlimitedAccess(userLevel.level)) {
    logger.warn({ 
      userPubkeyHex: userPubkeyHex.slice(0, 16) + '...', 
      cachedLevel: userLevel?.level || 'none' 
    }, 'User does not have unlimited access');
    throw error(403, 'Only users with unlimited access can clone repositories to the server. Please verify you can write to at least one default Nostr relay.');
  }

  try {
    // Decode npub to get pubkey
    const repoOwnerPubkey = requireNpubHex(npub);
    const repoPath = join(repoRoot, npub, `${repo}.git`);

    // Check if repo already exists
    if (existsSync(repoPath)) {
      return json({ 
        success: true, 
        message: 'Repository already exists locally',
        alreadyExists: true
      });
    }

    // Fetch repository announcement (case-insensitive)
    // Note: Nostr d-tag filters are case-sensitive, so we fetch all announcements by the author
    // and filter case-insensitively in JavaScript
    logger.debug({ npub, repo, repoOwnerPubkey: repoOwnerPubkey.slice(0, 16) + '...' }, 'Fetching repository announcement from Nostr (case-insensitive)');
    
    let authorAnnouncements: NostrEvent[];
    try {
      authorAnnouncements = await fetchRepoAnnouncementsWithCache(nostrClient, repoOwnerPubkey, eventCache);
      
      logger.debug({ 
        npub, 
        repo, 
        authorAnnouncementCount: authorAnnouncements.length,
        eventIds: authorAnnouncements.map(e => e.id)
      }, 'Fetched repository announcements by author');
    } catch (err) {
      logger.error({ 
        error: err, 
        npub, 
        repo, 
        repoOwnerPubkey: repoOwnerPubkey.slice(0, 16) + '...' 
      }, 'Error fetching repository announcement from Nostr');
      throw handleApiError(
        err instanceof Error ? err : new Error(String(err)),
        { operation: 'cloneRepo', npub, repo },
        'Failed to fetch repository announcement from Nostr relays. Please check that the repository exists and the relays are accessible.'
      );
    }

    // Find the matching repo announcement (case-insensitive)
    const announcementEvent = findRepoAnnouncement(authorAnnouncements, repo);

    if (!announcementEvent) {
      const dTags = authorAnnouncements
        .map(e => e.tags.find(t => t[0] === 'd')?.[1])
        .filter(Boolean);
      
      logger.warn({ 
        npub, 
        repo, 
        repoOwnerPubkey: repoOwnerPubkey.slice(0, 16) + '...',
        authorAnnouncementCount: authorAnnouncements.length,
        authorRepos: dTags,
        searchedRepo: repo
      }, 'Repository announcement not found in Nostr (case-insensitive search)');
      
      const errorMessage = authorAnnouncements.length > 0
        ? `Repository announcement not found in Nostr for ${npub}/${repo}. Found ${authorAnnouncements.length} other repository announcement(s) by this author. Please verify the repository name is correct.`
        : `Repository announcement not found in Nostr for ${npub}/${repo}. Please verify that the repository exists and has been announced on Nostr relays.`;
      
      throw handleValidationError(
        errorMessage,
        { operation: 'cloneRepo', npub, repo }
      );
    }
    
    // Extract and log clone URLs for debugging
    const cloneUrls: string[] = [];
    for (const tag of announcementEvent.tags) {
      if (tag[0] === 'clone') {
        for (let i = 1; i < tag.length; i++) {
          const url = tag[i];
          if (url && typeof url === 'string') {
            cloneUrls.push(url);
          }
        }
      }
    }
    
    logger.debug({ 
      npub, 
      repo, 
      cloneUrlCount: cloneUrls.length,
      cloneUrls: cloneUrls.slice(0, 5) // Log first 5 to avoid huge logs
    }, 'Repository announcement clone URLs');

    // Attempt to clone the repository
    const result = await repoManager.fetchRepoOnDemand(npub, repo, announcementEvent);

    if (!result.success) {
      if (result.needsAnnouncement) {
        throw handleValidationError(
          'Repository announcement is required. Please provide an announcement event or create one.',
          { operation: 'cloneRepo', npub, repo }
        );
      }
      
      // Build detailed error message
      let errorMessage = 'Could not clone repository.';
      if (result.error) {
        errorMessage += ` ${result.error}`;
      }
      if (result.cloneUrls && result.cloneUrls.length === 0) {
        errorMessage += ' No clone URLs found in the repository announcement.';
      } else if (result.remoteUrls && result.remoteUrls.length === 0) {
        errorMessage += ' No accessible remote clone URLs found.';
      } else if (result.cloneUrls && result.cloneUrls.length > 0) {
        errorMessage += ` Attempted to clone from: ${result.cloneUrls.join(', ')}`;
      }
      
      logger.error({ 
        npub, 
        repo, 
        error: result.error,
        cloneUrls: result.cloneUrls,
        remoteUrls: result.remoteUrls
      }, 'Failed to clone repository');
      
      throw handleApiError(
        new Error(result.error || 'Failed to clone repository from remote URLs'),
        { operation: 'cloneRepo', npub, repo },
        errorMessage
      );
    }

    // Verify repo exists after cloning
    if (!existsSync(repoPath)) {
      // Wait a moment for filesystem to sync
      await new Promise(resolve => setTimeout(resolve, 500));
      if (!existsSync(repoPath)) {
        throw handleApiError(
          new Error('Repository clone completed but repository is not accessible'),
          { operation: 'cloneRepo', npub, repo },
          'Repository clone completed but repository is not accessible'
        );
      }
    }

    logger.info({ npub, repo, userPubkeyHex: userPubkeyHex.slice(0, 16) + '...' }, 'Repository cloned successfully');

    return json({
      success: true,
      message: 'Repository cloned successfully',
      alreadyExists: false
    });
  } catch (err) {
    logger.error({ error: err, npub, repo }, 'Error cloning repository');
    
    // Re-throw auth errors as-is
    if (err instanceof Error && (err.message.includes('401') || err.message.includes('403'))) {
      throw err;
    }
    
    const error = err instanceof Error ? err : new Error(String(err));
    throw handleApiError(
      error,
      { operation: 'cloneRepo', npub, repo },
      'Failed to clone repository'
    );
  }
};
