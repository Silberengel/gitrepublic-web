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
import { getCachedUserLevel } from '$lib/services/security/user-level-cache.js';
import logger from '$lib/services/logger.js';
import { handleApiError, handleValidationError } from '$lib/utils/error-handler.js';

const repoRoot = process.env.GIT_REPO_ROOT || '/repos';
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

  // Check if user has unlimited access
  const userLevel = getCachedUserLevel(userPubkeyHex);
  if (!userLevel || userLevel.level !== 'unlimited') {
    throw error(403, 'Only users with unlimited access can clone repositories to the server.');
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

    // Fetch repository announcement
    const events = await nostrClient.fetchEvents([
      {
        kinds: [KIND.REPO_ANNOUNCEMENT],
        authors: [repoOwnerPubkey],
        '#d': [repo],
        limit: 1
      }
    ]);

    if (events.length === 0) {
      throw handleValidationError(
        'Repository announcement not found in Nostr',
        { operation: 'cloneRepo', npub, repo }
      );
    }

    const announcementEvent = events[0];

    // Attempt to clone the repository
    const cloned = await repoManager.fetchRepoOnDemand(npub, repo, announcementEvent);

    if (!cloned) {
      throw handleApiError(
        new Error('Failed to clone repository from remote URLs'),
        { operation: 'cloneRepo', npub, repo },
        'Could not clone repository. Please check that the repository has valid clone URLs and is accessible.'
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
