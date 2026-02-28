/**
 * RESTful Verification Resource Endpoint
 * 
 * GET    /api/repos/{npub}/{repo}/verification          # Get verification status
 * POST   /api/repos/{npub}/{repo}/verification          # Save announcement to repo
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createRepoGetHandler, createRepoPostHandler } from '$lib/utils/api-handlers.js';
import type { RepoRequestContext, RequestEvent } from '$lib/utils/api-context.js';
import { handleApiError } from '$lib/utils/error-handler.js';
import { fileManager } from '$lib/services/service-registry.js';
import { verifyRepositoryOwnership } from '$lib/services/nostr/repo-verification.js';
import type { NostrEvent } from '$lib/types/nostr.js';
import { nostrClient } from '$lib/services/service-registry.js';
import { existsSync } from 'fs';
import { join } from 'path';
import { extractRequestContext } from '$lib/utils/api-context.js';
import { eventCache } from '$lib/services/nostr/event-cache.js';
import { fetchRepoAnnouncementsWithCache, findRepoAnnouncement } from '$lib/utils/nostr-utils.js';
import { MaintainerService } from '$lib/services/nostr/maintainer-service.js';
import { DEFAULT_NOSTR_RELAYS } from '$lib/config.js';
import { AnnouncementManager } from '$lib/services/git/announcement-manager.js';
import { fetchUserEmail, fetchUserName } from '$lib/utils/user-profile.js';
import simpleGit from 'simple-git';
import logger from '$lib/services/logger.js';

const repoRoot = typeof process !== 'undefined' && process.env?.GIT_REPO_ROOT
  ? process.env.GIT_REPO_ROOT
  : '/repos';

const maintainerService = new MaintainerService(DEFAULT_NOSTR_RELAYS);
const announcementManager = new AnnouncementManager(repoRoot);

/**
 * GET: Get verification status
 */
export const GET: RequestHandler = createRepoGetHandler(
  async (context: RepoRequestContext) => {
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
        localOwner = await fileManager.getCurrentOwnerFromRepo(context.npub, context.repo);
        
        if (localOwner) {
          try {
            const repoEventsFile = await fileManager.getFileContent(context.npub, context.repo, 'nostr/repo-events.jsonl', 'HEAD');
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
  { operation: 'getVerification', requireRepoExists: false, requireRepoAccess: false }
);

/**
 * POST: Save announcement to repo
 */
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
      // Check if repository has any commits
      const git = simpleGit(repoPath);
      let hasCommits = false;
      let defaultBranch = process.env.DEFAULT_BRANCH || 'master';
      
      try {
        const commitCount = await git.raw(['rev-list', '--count', '--all']);
        hasCommits = parseInt(commitCount.trim(), 10) > 0;
      } catch {
        hasCommits = false;
      }
      
      if (hasCommits) {
        try {
          defaultBranch = await fileManager.getDefaultBranch(context.npub, context.repo);
        } catch {
          defaultBranch = process.env.DEFAULT_BRANCH || 'master';
        }
      }
      
      // Get worktree for the default branch
      logger.info({ npub: context.npub, repo: context.repo, branch: defaultBranch, hasCommits }, 'Getting worktree for announcement commit');
      const worktreePath = await fileManager.getWorktree(repoPath, defaultBranch, context.npub, context.repo);
      
      // Check if announcement already exists
      const hasAnnouncement = await announcementManager.hasAnnouncementInRepo(worktreePath, announcement.id);
      
      if (hasAnnouncement) {
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
      
      // For empty repositories, ensure the branch is set up in the worktree
      if (!hasCommits) {
        try {
          const currentBranch = await workGit.revparse(['--abbrev-ref', 'HEAD']).catch(() => null);
          if (!currentBranch || currentBranch === 'HEAD') {
            logger.debug({ npub: context.npub, repo: context.repo, branch: defaultBranch }, 'Creating orphan branch in worktree');
            await workGit.raw(['checkout', '--orphan', defaultBranch]);
          } else if (currentBranch !== defaultBranch) {
            logger.debug({ npub: context.npub, repo: context.repo, currentBranch, targetBranch: defaultBranch }, 'Switching to target branch in worktree');
            await workGit.checkout(defaultBranch);
          }
        } catch (branchErr) {
          logger.warn({ error: branchErr, npub: context.npub, repo: context.repo, branch: defaultBranch }, 'Branch setup in worktree failed, attempting commit anyway');
        }
      }
      
      logger.info({ npub: context.npub, repo: context.repo, branch: defaultBranch, hasCommits }, 'Committing announcement file');
      await workGit.commit(commitMessage, ['nostr/repo-events.jsonl'], {
        '--author': `${authorName} <${authorEmail}>`
      });
      
      // Verify commit was created
      const commitHash = await workGit.revparse(['HEAD']).catch(() => null);
      if (!commitHash) {
        throw new Error('Commit was created but HEAD is not pointing to a valid commit');
      }
      logger.info({ npub: context.npub, repo: context.repo, commitHash, branch: defaultBranch }, 'Announcement committed successfully');

      // Push to default branch (if there's a remote)
      try {
        await workGit.push('origin', defaultBranch);
      } catch (pushErr) {
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
      return handleApiError(err, { operation: 'saveAnnouncement', npub: context.npub, repo: context.repo }, 'Failed to commit announcement');
    }
  },
  { operation: 'saveAnnouncement', requireRepoExists: true, requireRepoAccess: true }
);
