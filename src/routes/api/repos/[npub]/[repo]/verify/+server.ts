/**
 * API endpoint for verifying repository ownership
 */

import { json, error } from '@sveltejs/kit';
// @ts-ignore - SvelteKit generates this type
import type { RequestHandler } from './$types';
import { fileManager } from '$lib/services/service-registry.js';
import { verifyRepositoryOwnership, VERIFICATION_FILE_PATH } from '$lib/services/nostr/repo-verification.js';
import { nostrClient } from '$lib/services/service-registry.js';
import { KIND } from '$lib/types/nostr.js';
import { existsSync } from 'fs';
import { join } from 'path';
import { decodeNpubToHex } from '$lib/utils/npub-utils.js';
import { createRepoGetHandler } from '$lib/utils/api-handlers.js';
import type { RepoRequestContext } from '$lib/utils/api-context.js';
import { handleApiError } from '$lib/utils/error-handler.js';

const repoRoot = typeof process !== 'undefined' && process.env?.GIT_REPO_ROOT
  ? process.env.GIT_REPO_ROOT
  : '/repos';

export const GET: RequestHandler = createRepoGetHandler(
  async (context: RepoRequestContext) => {
    // Check if repository exists - verification doesn't require the repo to be cloned locally
    // We can verify ownership from Nostr events alone

    // Fetch the repository announcement
    const events = await nostrClient.fetchEvents([
      {
        kinds: [KIND.REPO_ANNOUNCEMENT],
        authors: [context.repoOwnerPubkey],
        '#d': [context.repo],
        limit: 1
      }
    ]);

    if (events.length === 0) {
      return json({
        verified: false,
        error: 'Repository announcement not found',
        message: 'Could not find a NIP-34 repository announcement for this repository.'
      });
    }

    const announcement = events[0];

    // Extract clone URLs from announcement
    const cloneUrls: string[] = [];
    for (const tag of announcement.tags) {
      if (tag[0] === 'clone') {
        for (let i = 1; i < tag.length; i++) {
          const url = tag[i];
          if (url && typeof url === 'string') {
            cloneUrls.push(url);
          }
        }
      }
    }

    // Verify ownership for each clone separately
    // Ownership is determined by the most recent announcement file checked into each clone
    const cloneVerifications: Array<{ url: string; verified: boolean; ownerPubkey: string | null; error?: string }> = [];
    
    // First, verify the local GitRepublic clone (if it exists)
    let localVerified = false;
    let localOwner: string | null = null;
    let localError: string | undefined;
    
    try {
      // Get current owner from the most recent announcement file in the repo
      localOwner = await fileManager.getCurrentOwnerFromRepo(context.npub, context.repo);
      
      if (localOwner) {
        // Verify the announcement file matches the announcement event
        try {
          const announcementFile = await fileManager.getFileContent(context.npub, context.repo, VERIFICATION_FILE_PATH, 'HEAD');
          const verification = verifyRepositoryOwnership(announcement, announcementFile.content);
          localVerified = verification.valid;
          if (!verification.valid) {
            localError = verification.error;
          }
        } catch (err) {
          localVerified = false;
          localError = 'Announcement file not found in repository';
        }
      } else {
        localVerified = false;
        localError = 'No announcement file found in repository';
      }
    } catch (err) {
      localVerified = false;
      localError = err instanceof Error ? err.message : 'Failed to verify local clone';
    }
    
    // Add local clone verification
    const localUrl = cloneUrls.find(url => url.includes(context.npub) || url.includes(context.repoOwnerPubkey));
    if (localUrl) {
      cloneVerifications.push({
        url: localUrl,
        verified: localVerified,
        ownerPubkey: localOwner,
        error: localError
      });
    }
    
    // For other clones (GitHub, GitLab, etc.), we'd need to fetch them first to check their announcement files
    // This is a future enhancement - for now we only verify the local GitRepublic clone
    
    // Overall verification: at least one clone must be verified
    const overallVerified = cloneVerifications.some(cv => cv.verified);
    const verifiedClones = cloneVerifications.filter(cv => cv.verified);
    const currentOwner = localOwner || context.repoOwnerPubkey;

    if (overallVerified) {
      return json({
        verified: true,
        announcementId: announcement.id,
        ownerPubkey: currentOwner,
        verificationMethod: 'announcement-file',
        cloneVerifications: cloneVerifications.map(cv => ({
          url: cv.url,
          verified: cv.verified,
          ownerPubkey: cv.ownerPubkey,
          error: cv.error
        })),
        message: `Repository ownership verified successfully for ${verifiedClones.length} clone(s)`
      });
    } else {
      return json({
        verified: false,
        error: localError || 'Repository ownership verification failed',
        announcementId: announcement.id,
        verificationMethod: 'announcement-file',
        cloneVerifications: cloneVerifications.map(cv => ({
          url: cv.url,
          verified: cv.verified,
          ownerPubkey: cv.ownerPubkey,
          error: cv.error
        })),
        message: 'Repository ownership verification failed for all clones'
      });
    }
  },
  { operation: 'verifyRepo', requireRepoExists: false, requireRepoAccess: false } // Verification is public, doesn't need repo to exist
);
