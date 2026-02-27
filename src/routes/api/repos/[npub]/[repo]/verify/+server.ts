/**
 * API endpoint for verifying repository ownership
 */

import { json, error } from '@sveltejs/kit';
// @ts-ignore - SvelteKit generates this type
import type { RequestHandler } from './$types';
import { fileManager } from '$lib/services/service-registry.js';
import { verifyRepositoryOwnership } from '$lib/services/nostr/repo-verification.js';
import type { NostrEvent } from '$lib/types/nostr.js';
import { nostrClient } from '$lib/services/service-registry.js';
import { KIND } from '$lib/types/nostr.js';
import { existsSync } from 'fs';
import { join } from 'path';
import { decodeNpubToHex } from '$lib/utils/npub-utils.js';
import { createRepoGetHandler, createRepoPostHandler } from '$lib/utils/api-handlers.js';
import type { RepoRequestContext, RequestEvent } from '$lib/utils/api-context.js';
import { handleApiError, handleValidationError } from '$lib/utils/error-handler.js';
import { eventCache } from '$lib/services/nostr/event-cache.js';
import { fetchRepoAnnouncementsWithCache, findRepoAnnouncement } from '$lib/utils/nostr-utils.js';
import { MaintainerService } from '$lib/services/nostr/maintainer-service.js';
import { DEFAULT_NOSTR_RELAYS } from '$lib/config.js';
import { AnnouncementManager } from '$lib/services/git/announcement-manager.js';
import { extractRequestContext } from '$lib/utils/api-context.js';
import { fetchUserEmail, fetchUserName } from '$lib/utils/user-profile.js';
import simpleGit from 'simple-git';
import logger from '$lib/services/logger.js';

const repoRoot = typeof process !== 'undefined' && process.env?.GIT_REPO_ROOT
  ? process.env.GIT_REPO_ROOT
  : '/repos';

export const GET: RequestHandler = createRepoGetHandler(
  async (context: RepoRequestContext) => {
    // Check if repository exists - verification doesn't require the repo to be cloned locally
    // We can verify ownership from Nostr events alone

    // Fetch the repository announcement (case-insensitive) with caching
    const allEvents = await fetchRepoAnnouncementsWithCache(nostrClient, context.repoOwnerPubkey, eventCache);
    const announcement = findRepoAnnouncement(allEvents, context.repo);

    if (!announcement) {
      return json({
        verified: false,
        error: 'Repository announcement not found',
        message: 'Could not find a NIP-34 repository announcement for this repository.'
      });
    }

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
    const repoPath = join(repoRoot, context.npub, `${context.repo}.git`);
    const repoExists = existsSync(repoPath);
    
    if (repoExists) {
      // Repo is cloned - verify the announcement file matches
      try {
        // Get current owner from the most recent announcement file in the repo
        localOwner = await fileManager.getCurrentOwnerFromRepo(context.npub, context.repo);
        
        if (localOwner) {
          // Verify the announcement in nostr/repo-events.jsonl matches the announcement event
          try {
            const repoEventsFile = await fileManager.getFileContent(context.npub, context.repo, 'nostr/repo-events.jsonl', 'HEAD');
            // Parse repo-events.jsonl and find the most recent announcement
            const lines = repoEventsFile.content.trim().split('\n').filter(Boolean);
            let repoAnnouncement: NostrEvent | null = null;
            let latestTimestamp = 0;
            
            for (const line of lines) {
              try {
                const entry = JSON.parse(line);
                if (entry.type === 'announcement' && entry.event && entry.timestamp) {
                  if (entry.timestamp > latestTimestamp) {
                    latestTimestamp = entry.timestamp;
                    repoAnnouncement = entry.event;
                  }
                }
              } catch {
                continue;
              }
            }
            
            if (repoAnnouncement) {
              const verification = verifyRepositoryOwnership(announcement, JSON.stringify(repoAnnouncement));
              localVerified = verification.valid;
              if (!verification.valid) {
                localError = verification.error;
              }
            } else {
              localVerified = false;
              localError = 'No announcement found in nostr/repo-events.jsonl';
            }
          } catch (err) {
            localVerified = false;
            localError = 'Announcement file not found in repository';
          }
        } else {
          localVerified = false;
          localError = 'No announcement found in repository';
        }
      } catch (err) {
        localVerified = false;
        localError = err instanceof Error ? err.message : 'Failed to verify local clone';
      }
    } else {
      // Repo is not cloned yet - verify from Nostr announcement alone
      // The announcement pubkey must match the repo owner
      if (announcement.pubkey === context.repoOwnerPubkey) {
        localVerified = true;
        localOwner = context.repoOwnerPubkey;
        localError = undefined;
      } else {
        localVerified = false;
        localOwner = announcement.pubkey;
        localError = 'Announcement pubkey does not match repository owner';
      }
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

const maintainerService = new MaintainerService(DEFAULT_NOSTR_RELAYS);
const announcementManager = new AnnouncementManager(repoRoot);

export const POST: RequestHandler = createRepoPostHandler(
  async (context: RepoRequestContext, event: RequestEvent) => {
    const requestContext = extractRequestContext(event);
    const userPubkeyHex = requestContext.userPubkeyHex;

    if (!userPubkeyHex) {
      return error(401, 'Authentication required. Please provide userPubkey.');
    }

    // Check if user is a maintainer or the repository owner
    const isMaintainer = await maintainerService.isMaintainer(userPubkeyHex, context.repoOwnerPubkey, context.repo);
    const isOwner = userPubkeyHex === context.repoOwnerPubkey;
    if (!isMaintainer && !isOwner) {
      return error(403, 'Only repository owners and maintainers can save announcements.');
    }

    // Check if repository is cloned
    const repoPath = join(repoRoot, context.npub, `${context.repo}.git`);
    if (!existsSync(repoPath)) {
      return error(404, 'Repository is not cloned locally. Please clone the repository first.');
    }

    // Fetch the repository announcement
    const allEvents = await fetchRepoAnnouncementsWithCache(nostrClient, context.repoOwnerPubkey, eventCache);
    const announcement = findRepoAnnouncement(allEvents, context.repo);

    if (!announcement) {
      return error(404, 'Repository announcement not found');
    }

    try {
      // Get default branch
      const defaultBranch = await fileManager.getDefaultBranch(context.npub, context.repo);
      
      // Get worktree for the default branch
      const worktreePath = await fileManager.getWorktree(repoPath, defaultBranch, context.npub, context.repo);
      
      // Check if announcement already exists
      const hasAnnouncement = await announcementManager.hasAnnouncementInRepo(worktreePath, announcement.id);
      
      if (hasAnnouncement) {
        // Announcement already exists, but we'll update it anyway to ensure it's the latest
        logger.debug({ npub: context.npub, repo: context.repo, eventId: announcement.id }, 'Announcement already exists, updating anyway');
      }
      
      // Save announcement to worktree
      const saved = await announcementManager.saveRepoEventToWorktree(worktreePath, announcement, 'announcement', false);
      
      if (!saved) {
        return error(500, 'Failed to save announcement to repository');
      }

      // Stage the file
      const workGit = simpleGit(worktreePath);
      await workGit.add('nostr/repo-events.jsonl');

      // Get author info
      let authorName = await fetchUserName(userPubkeyHex, requestContext.userPubkey || '', DEFAULT_NOSTR_RELAYS);
      let authorEmail = await fetchUserEmail(userPubkeyHex, requestContext.userPubkey || '', DEFAULT_NOSTR_RELAYS);
      
      if (!authorName) {
        const { nip19 } = await import('nostr-tools');
        const npub = requestContext.userPubkey || nip19.npubEncode(userPubkeyHex);
        authorName = npub.substring(0, 20);
      }
      if (!authorEmail) {
        const { nip19 } = await import('nostr-tools');
        const npub = requestContext.userPubkey || nip19.npubEncode(userPubkeyHex);
        authorEmail = `${npub.substring(0, 20)}@gitrepublic.web`;
      }

      // Commit the announcement
      const commitMessage = `Verify repository ownership by committing repo announcement event\n\nEvent ID: ${announcement.id}`;
      await workGit.commit(commitMessage, ['nostr/repo-events.jsonl'], {
        '--author': `${authorName} <${authorEmail}>`
      });

      // Push to default branch (if there's a remote)
      try {
        await workGit.push('origin', defaultBranch);
      } catch (pushErr) {
        // Push might fail if there's no remote, that's okay
        logger.debug({ error: pushErr, npub: context.npub, repo: context.repo }, 'Push failed (may not have remote)');
      }

      // Clean up worktree
      await fileManager.removeWorktree(repoPath, worktreePath);

      return json({
        success: true,
        message: 'Repository announcement committed successfully. Verification should update shortly.',
        announcementId: announcement.id
      });
    } catch (err) {
      logger.error({ error: err, npub: context.npub, repo: context.repo }, 'Failed to commit announcement for verification');
      return handleApiError(err, { operation: 'verifyRepoCommit', npub: context.npub, repo: context.repo }, 'Failed to commit announcement');
    }
  },
  { operation: 'verifyRepoCommit', requireRepoExists: true, requireRepoAccess: true }
);
