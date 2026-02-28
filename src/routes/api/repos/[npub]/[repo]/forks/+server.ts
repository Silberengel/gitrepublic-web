/**
 * RESTful Forks Resource Endpoint
 * 
 * GET    /api/repos/{npub}/{repo}/forks                 # List forks / Get fork info
 * POST   /api/repos/{npub}/{repo}/forks                 # Create fork (fork this repo)
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createRepoGetHandler, createRepoPostHandler } from '$lib/utils/api-handlers.js';
import type { RepoRequestContext, RequestEvent } from '$lib/utils/api-context.js';
import { handleApiError } from '$lib/utils/error-handler.js';
import { DEFAULT_NOSTR_RELAYS, combineRelays } from '$lib/config.js';
import { getUserRelays } from '$lib/services/nostr/user-relays.js';
import { NostrClient } from '$lib/services/nostr/nostr-client.js';
import { KIND, type NostrEvent } from '$lib/types/nostr.js';
import { getVisibility, getProjectRelays } from '$lib/utils/repo-visibility.js';
import { nip19 } from 'nostr-tools';
import { signEventWithNIP07 } from '$lib/services/nostr/nip07-signer.js';
import { requireNpubHex, decodeNpubToHex } from '$lib/utils/npub-utils.js';
import { OwnershipTransferService } from '$lib/services/nostr/ownership-transfer-service.js';
import { existsSync, statSync } from 'fs';
import { rm } from 'fs/promises';
import { join, resolve } from 'path';
import simpleGit from 'simple-git';
import { validateRepoPath } from '$lib/utils/security.js';
import { sanitizeRepoNameForFilesystem } from '$lib/utils/input-validation.js';
import { ResourceLimits } from '$lib/services/security/resource-limits.js';
import { auditLogger } from '$lib/services/security/audit-logger.js';
import { ForkCountService } from '$lib/services/nostr/fork-count-service.js';
import { getCachedUserLevel, cacheUserLevel } from '$lib/services/security/user-level-cache.js';
import { hasUnlimitedAccess } from '$lib/utils/user-access.js';
import { verifyRelayWriteProof } from '$lib/services/nostr/relay-write-proof.js';
import { verifyEvent } from 'nostr-tools';
import logger from '$lib/services/logger.js';
import { eventCache } from '$lib/services/nostr/event-cache.js';
import { fetchRepoAnnouncementsWithCache, findRepoAnnouncement } from '$lib/utils/nostr-utils.js';
import { repoManager, nostrClient, forkCountService } from '$lib/services/service-registry.js';

// Resolve GIT_REPO_ROOT to absolute path
const repoRootEnv = process.env.GIT_REPO_ROOT || '/repos';
const repoRoot = resolve(repoRootEnv);
const resourceLimits = new ResourceLimits(repoRoot);

/**
 * Retry publishing an event with exponential backoff
 */
async function publishEventWithRetry(
  event: NostrEvent,
  relays: string[],
  eventName: string,
  maxAttempts: number = 3,
  context?: string
): Promise<{ success: string[]; failed: Array<{ relay: string; error: string }> }> {
  let lastResult: { success: string[]; failed: Array<{ relay: string; error: string }> } | null = null;
  const eventId = event.id.slice(0, 8);
  const logContext = context || `[event:${eventId}]`;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    logger.info({ logContext, eventName, attempt, maxAttempts }, `[Fork] Publishing ${eventName} - Attempt ${attempt}/${maxAttempts}...`);
    
    lastResult = await nostrClient.publishEvent(event, relays);
    
    if (lastResult.success.length > 0) {
      logger.info({ logContext, eventName, successCount: lastResult.success.length }, `[Fork] ${eventName} published successfully`);
      return lastResult;
    }
    
    if (attempt < maxAttempts) {
      const delayMs = Math.pow(2, attempt - 1) * 1000;
      logger.warn({ logContext, eventName, attempt, delayMs }, `[Fork] ${eventName} failed on attempt ${attempt}. Retrying...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  
  logger.error({ logContext, eventName, maxAttempts }, `[Fork] ${eventName} failed after ${maxAttempts} attempts`);
  return lastResult!;
}

/**
 * GET: Get fork information
 * Returns whether this repo is a fork and original repo info
 */
export const GET: RequestHandler = createRepoGetHandler(
  async (context: RepoRequestContext) => {
    try {
      // Get repo announcement (case-insensitive) with caching
      const allAnnouncements = await fetchRepoAnnouncementsWithCache(nostrClient, context.repoOwnerPubkey, eventCache);
      const announcement = findRepoAnnouncement(allAnnouncements, context.repo);

      if (!announcement) {
        return error(404, 'Repository announcement not found');
      }

      // Check if this is a fork
      const isFork = announcement.tags.some(t => t[0] === 'fork');
      
      // Get original repo reference
      const originalRepoTag = announcement.tags.find(t => t[0] === 'fork');
      let originalRepo: { npub: string; repo: string } | null = null;
      
      if (originalRepoTag && originalRepoTag[1]) {
        const match = originalRepoTag[1].match(new RegExp(`^${KIND.REPO_ANNOUNCEMENT}:([a-f0-9]{64}):(.+)$`));
        if (match) {
          const [, originalOwnerPubkey, originalRepoName] = match;
          try {
            const originalNpub = nip19.npubEncode(originalOwnerPubkey);
            originalRepo = { npub: originalNpub, repo: originalRepoName };
          } catch {
            // Invalid pubkey
          }
        }
      }

      // Get fork count for this repo (if not a fork itself)
      let forkCount = 0;
      if (!isFork && context.repoOwnerPubkey && context.repo) {
        try {
          forkCount = await forkCountService.getForkCount(context.repoOwnerPubkey, context.repo);
        } catch (err) {
          logger.warn({ error: err, npub: context.npub, repo: context.repo }, 'Failed to get fork count');
        }
      }

      return json({
        isFork,
        originalRepo,
        forkCount
      });
    } catch (err) {
      return handleApiError(err, { operation: 'getForkInfo', npub: context.npub, repo: context.repo }, 'Failed to get fork information');
    }
  },
  { operation: 'getForkInfo', requireRepoExists: false, requireRepoAccess: false }
);

/**
 * POST: Create fork
 * Body: { userPubkey, forkName?, localOnly? }
 * Note: Forking doesn't require maintainer status - anyone can fork a repo they can view
 */
export const POST: RequestHandler = createRepoPostHandler(
  async (context: RepoRequestContext, event: RequestEvent) => {
    try {
      const body = await event.request.json();
      const { userPubkey, forkName, localOnly, proofEvent, forkAnnouncementEvent, ownershipTransferEvent } = body;

      if (!userPubkey) {
        return error(401, 'Authentication required. Please provide userPubkey.');
      }
      
      const isLocalOnly = localOnly === true;
      const originalOwnerPubkey = context.repoOwnerPubkey;

      // Decode user pubkey
      const userPubkeyHex = decodeNpubToHex(userPubkey) || userPubkey;
      const userNpub = nip19.npubEncode(userPubkeyHex);
      
      // Determine fork name and sanitize it for filesystem use
      // The d-tag (repo identifier) must be filesystem-safe (lowercase, no spaces, etc.)
      const rawForkName = forkName || context.repo;
      const forkRepoName = sanitizeRepoNameForFilesystem(rawForkName);
      
      if (!forkRepoName || forkRepoName.length === 0) {
        return error(400, 'Invalid fork repository name. Please use only alphanumeric characters, hyphens, and dots.');
      }

      // Check if user has unlimited access
      let userLevel = getCachedUserLevel(userPubkeyHex);
      logger.debug({ 
        userPubkeyHex: userPubkeyHex.substring(0, 16) + '...',
        hasCachedLevel: !!userLevel,
        cachedLevel: userLevel?.level,
        cachedAt: userLevel?.cachedAt ? new Date(userLevel.cachedAt).toISOString() : null,
        expiresAt: userLevel?.expiresAt ? new Date(userLevel.expiresAt).toISOString() : null,
        hasProofEvent: !!proofEvent
      }, '[Fork] Checking user level');
      
      // If cache is empty and proof event is provided, try to verify and cache it
      if (!userLevel && proofEvent) {
        logger.info({ 
          userPubkeyHex: userPubkeyHex.substring(0, 16) + '...',
          proofEventKind: proofEvent.kind
        }, '[Fork] Cache empty, attempting to verify proof event');
        
        // Validate proof event structure
        if (!proofEvent.kind || !proofEvent.pubkey || !proofEvent.created_at || !proofEvent.id) {
          logger.warn({ userPubkeyHex: userPubkeyHex.substring(0, 16) + '...' }, '[Fork] Invalid proof event structure');
          return error(400, 'Invalid proof event structure');
        }
        
        // Validate proof event signature
        if (!verifyEvent(proofEvent)) {
          logger.warn({ userPubkeyHex: userPubkeyHex.substring(0, 16) + '...' }, '[Fork] Invalid proof event signature');
          return error(400, 'Invalid proof event signature');
        }
        
        // Verify pubkey matches
        if (proofEvent.pubkey !== userPubkeyHex) {
          logger.warn({ 
            userPubkeyHex: userPubkeyHex.substring(0, 16) + '...',
            proofPubkey: proofEvent.pubkey.substring(0, 16) + '...'
          }, '[Fork] Proof event pubkey does not match user pubkey');
          return error(400, 'Proof event pubkey does not match user pubkey');
        }
        
        // Verify relay write proof
        const verification = await verifyRelayWriteProof(
          proofEvent,
          userPubkeyHex,
          DEFAULT_NOSTR_RELAYS
        );
        
        if (verification.valid) {
          // Cache the successful verification
          cacheUserLevel(userPubkeyHex, 'unlimited');
          userLevel = getCachedUserLevel(userPubkeyHex);
          logger.info({ 
            userPubkeyHex: userPubkeyHex.substring(0, 16) + '...',
            relay: verification.relay
          }, '[Fork] Proof verified, user level cached as unlimited');
        } else if (verification.relayDown) {
          logger.warn({ 
            userPubkeyHex: userPubkeyHex.substring(0, 16) + '...',
            error: verification.error
          }, '[Fork] Relays down, cannot verify proof event');
          return error(503, 'Relays are temporarily unavailable. Please try again later or verify your access first.');
        } else {
          // User is logged in but no write access - cache as rate_limited
          cacheUserLevel(userPubkeyHex, 'rate_limited');
          userLevel = getCachedUserLevel(userPubkeyHex);
          logger.info({ 
            userPubkeyHex: userPubkeyHex.substring(0, 16) + '...',
            error: verification.error
          }, '[Fork] Proof verification failed, user level cached as rate_limited');
        }
      }
      
      if (!hasUnlimitedAccess(userLevel?.level)) {
        const clientIp = event.request.headers.get('x-forwarded-for') || event.request.headers.get('x-real-ip') || 'unknown';
        const reason = !userLevel 
          ? 'User level not cached - please verify write access first'
          : `User level is ${userLevel.level}, not unlimited`;
        
        logger.warn({ 
          userPubkeyHex: userPubkeyHex.substring(0, 16) + '...',
          reason,
          cachedLevel: userLevel?.level,
          hadProofEvent: !!proofEvent
        }, '[Fork] Access denied - user does not have unlimited access');
        
        auditLogger.logRepoFork(
          userPubkeyHex,
          `${context.npub}/${context.repo}`,
          `${userNpub}/${forkRepoName}`,
          'failure',
          reason
        );
        
        const errorMessage = !userLevel
          ? 'Repository creation requires unlimited access. Please verify you can write to at least one default Nostr relay by visiting your profile or the signup page first, or provide a proof event in the request.'
          : `Repository creation requires unlimited access. Your current access level is ${userLevel.level}. Please verify you can write to at least one default Nostr relay.`;
        
        return error(403, errorMessage);
      }

      // Check resource limits
      const resourceCheck = await resourceLimits.canCreateRepo(userNpub);
      if (!resourceCheck.allowed) {
        const clientIp = event.request.headers.get('x-forwarded-for') || event.request.headers.get('x-real-ip') || 'unknown';
        auditLogger.logRepoFork(
          userPubkeyHex,
          `${context.npub}/${context.repo}`,
          `${userNpub}/${forkRepoName}`,
          'failure',
          resourceCheck.reason
        );
        return error(403, resourceCheck.reason || 'Resource limit exceeded');
      }

      // Get original repo announcement first (needed for clone URLs)
      const allAnnouncements = await fetchRepoAnnouncementsWithCache(nostrClient, originalOwnerPubkey, eventCache);
      const originalAnnouncement = findRepoAnnouncement(allAnnouncements, context.repo);

      if (!originalAnnouncement) {
        return error(404, 'Original repository announcement not found');
      }

      // Extract clone URLs from announcement
      const { extractCloneUrls } = await import('$lib/utils/nostr-utils.js');
      const allOriginalCloneUrls = extractCloneUrls(originalAnnouncement);
      
      if (allOriginalCloneUrls.length === 0) {
        return error(400, 'Original repository has no clone URLs available');
      }

      // Check if original repo exists locally (preferred for faster cloning)
      const originalRepoPath = join(repoRoot, context.npub, `${context.repo}.git`);
      const originalPathValidation = validateRepoPath(originalRepoPath, repoRoot);
      const originalRepoExistsLocally = originalPathValidation.valid && existsSync(originalRepoPath);
      
      logger.debug({ 
        originalRepoExistsLocally,
        cloneUrlCount: allOriginalCloneUrls.length,
        npub: context.npub,
        repo: context.repo
      }, '[Fork] Checking original repository availability');

      // Check if fork already exists
      const forkRepoPath = join(repoRoot, userNpub, `${forkRepoName}.git`);
      const forkPathValidation = validateRepoPath(forkRepoPath, repoRoot);
      if (!forkPathValidation.valid) {
        return error(403, forkPathValidation.error || 'Invalid fork repository path');
      }
      
      // Check if directory exists and is actually a directory (not a file)
      let forkDirExists = false;
      try {
        if (existsSync(forkRepoPath)) {
          const stats = statSync(forkRepoPath);
          forkDirExists = stats.isDirectory();
          
          if (!forkDirExists) {
            logger.warn({ 
              forkRepoPath,
              userNpub,
              forkRepoName
            }, '[Fork] Path exists but is not a directory - removing and allowing fork creation');
            // Remove the file and allow fork creation
            await rm(forkRepoPath, { force: true, recursive: true });
          }
        }
      } catch (err) {
        logger.warn({ 
          error: err,
          forkRepoPath,
          userNpub,
          forkRepoName
        }, '[Fork] Error checking fork directory existence');
        // If we can't check, assume it doesn't exist and proceed
        forkDirExists = false;
      }
      
      // If directory exists, fork already exists
      if (forkDirExists) {
        logger.warn({ 
          forkRepoPath,
          userNpub,
          forkRepoName
        }, '[Fork] Fork directory already exists');
        return error(409, 'Fork already exists');
      }
      
      // Check if fork announcement exists but directory doesn't (orphaned announcement)
      // In this case, we'll allow the fork to be created again
      try {
        const allForkAnnouncements = await fetchRepoAnnouncementsWithCache(nostrClient, userPubkeyHex, eventCache);
        const existingForkAnnouncement = findRepoAnnouncement(allForkAnnouncements, forkRepoName);
        
        if (existingForkAnnouncement && !forkDirExists) {
          logger.info({ 
            userNpub,
            forkRepoName,
            announcementId: existingForkAnnouncement.id
          }, '[Fork] Fork announcement exists but directory is missing - allowing fork creation to proceed');
          // Allow fork creation to proceed - the directory will be created
        }
      } catch (err) {
        logger.warn({ 
          error: err,
          userNpub,
          forkRepoName
        }, '[Fork] Failed to check for existing fork announcement, proceeding with fork creation');
        // Continue with fork creation even if announcement check fails
      }

      // Clone the repository
      const clientIp = event.request.headers.get('x-forwarded-for') || event.request.headers.get('x-real-ip') || 'unknown';
      auditLogger.logRepoFork(
        userPubkeyHex,
        `${context.npub}/${context.repo}`,
        `${userNpub}/${forkRepoName}`,
        'success'
      );
      
      const git = simpleGit();
      
      // Clone from local repo if available, otherwise clone from remote URL
      if (originalRepoExistsLocally) {
        logger.info({ 
          source: 'local',
          originalRepoPath,
          forkRepoPath: forkRepoPath
        }, '[Fork] Cloning from local repository');
        await git.clone(originalRepoPath, forkRepoPath, ['--bare']);
      } else {
        // Clone from the first available clone URL
        // Prefer HTTPS URLs, then SSH, then others
        const httpsUrls = allOriginalCloneUrls.filter(url => url.startsWith('https://'));
        const sshUrls = allOriginalCloneUrls.filter(url => url.startsWith('git@') || url.startsWith('ssh://'));
        const otherUrls = allOriginalCloneUrls.filter(url => !url.startsWith('https://') && !url.startsWith('git@') && !url.startsWith('ssh://'));
        
        const preferredUrls = [...httpsUrls, ...sshUrls, ...otherUrls];
        const cloneUrl = preferredUrls[0];
        
        if (!cloneUrl) {
          return error(400, 'No valid clone URL available for the original repository');
        }
        
        logger.info({ 
          source: 'remote',
          cloneUrl,
          forkRepoPath,
          totalUrls: allOriginalCloneUrls.length
        }, '[Fork] Cloning from remote repository');
        
        try {
          await git.clone(cloneUrl, forkRepoPath, ['--bare']);
        } catch (cloneError) {
          logger.error({ 
            error: cloneError,
            cloneUrl,
            forkRepoPath
          }, '[Fork] Failed to clone from remote URL');
          
          // If first URL failed, try other URLs
          let cloned = false;
          for (let i = 1; i < preferredUrls.length && !cloned; i++) {
            try {
              logger.info({ 
                attempt: i + 1,
                cloneUrl: preferredUrls[i]
              }, '[Fork] Trying alternative clone URL');
              await git.clone(preferredUrls[i], forkRepoPath, ['--bare']);
              cloned = true;
            } catch (altError) {
              logger.warn({ 
                error: altError,
                cloneUrl: preferredUrls[i]
              }, '[Fork] Alternative clone URL also failed');
            }
          }
          
          if (!cloned) {
            return error(500, `Failed to clone repository from any available URL. Please ensure the repository is accessible and you have the necessary permissions.`);
          }
        }
      }
      
      // Get the HEAD commit from the cloned fork repository (this is the current last commit at fork time)
      let forkHeadCommit: string | null = null;
      try {
        const forkGit = simpleGit(forkRepoPath);
        const headCommit = await forkGit.revparse(['HEAD']);
        if (headCommit && /^[0-9a-f]{40}$/i.test(headCommit.trim())) {
          forkHeadCommit = headCommit.trim();
          logger.info({ 
            forkRepoPath,
            headCommit: forkHeadCommit
          }, '[Fork] Retrieved HEAD commit from cloned fork repository');
        }
      } catch (err) {
        logger.warn({ 
          error: err,
          forkRepoPath
        }, '[Fork] Failed to get HEAD commit from fork repository, will use original earliest commit');
      }
      
      // Invalidate resource limit cache
      resourceLimits.invalidateCache(userNpub);

      // Create fork announcement
      const gitDomain = process.env.GIT_DOMAIN || 'localhost:6543';
      const isLocalhost = gitDomain.startsWith('localhost') || gitDomain.startsWith('127.0.0.1');
      const protocol = isLocalhost ? 'http' : 'https';
      const forkGitUrl = `${protocol}://${gitDomain}/${userNpub}/${forkRepoName}.git`;

      // Get Tor .onion URL if available
      const { getTorGitUrl } = await import('$lib/services/tor/hidden-service.js');
      const torOnionUrl = await getTorGitUrl(userNpub, forkRepoName);

      // Extract original clone URLs (excluding our domain and Tor URLs)
      const originalCloneUrlsForFork = allOriginalCloneUrls
        .filter(url => {
          if (url.includes(gitDomain)) return false;
          if (url.includes('.onion')) return false;
          return true;
        });

      // For forks, use the HEAD commit of the forked repository as the earliest commit
      // This represents the state of the repo at the time of forking
      const earliestCommit = forkHeadCommit || (() => {
        // Fallback to original earliest commit if we couldn't get HEAD
        const earliestCommitTag = originalAnnouncement.tags.find(t => t[0] === 'r' && t[2] === 'euc');
        return earliestCommitTag?.[1];
      })();

      // Get original repo name and description
      const originalName = originalAnnouncement.tags.find(t => t[0] === 'name')?.[1] || context.repo;
      const originalDescription = originalAnnouncement.tags.find(t => t[0] === 'description')?.[1] || '';

      // Build clone URLs for fork
      const forkCloneUrls: string[] = [];
      
      if (!isLocalhost && !forkGitUrl.includes('localhost') && !forkGitUrl.includes('127.0.0.1')) {
        forkCloneUrls.push(forkGitUrl);
      }
      
      if (torOnionUrl) {
        forkCloneUrls.push(torOnionUrl);
      }
      
      forkCloneUrls.push(...originalCloneUrlsForFork);

      // Validate: If using localhost, require either Tor .onion URL or at least one other clone URL
      if (isLocalhost && !torOnionUrl && originalCloneUrlsForFork.length === 0) {
        return error(400, 'Cannot create fork with only localhost. The original repository must have at least one public clone URL, or you need to configure a Tor .onion address.');
      }

      // Preserve visibility and project-relay from original repo
      const originalVisibility = getVisibility(originalAnnouncement);
      const originalProjectRelays = getProjectRelays(originalAnnouncement);
      
      // Build fork announcement tags
      const originalRepoTag = `${KIND.REPO_ANNOUNCEMENT}:${originalOwnerPubkey}:${context.repo}`;
      const tags: string[][] = [
        ['d', forkRepoName],
        ['name', originalName], // Don't append "(fork)" to the name
        ['description', `Fork of ${originalName}${originalDescription ? `: ${originalDescription}` : ''}`],
        ['clone', ...forkCloneUrls],
        ['relays', ...DEFAULT_NOSTR_RELAYS],
        ['fork', originalRepoTag],
        ['p', originalOwnerPubkey],
      ];
      
      // Local-only forks are always private
      if (isLocalOnly) {
        tags.push(['visibility', 'private']);
        tags.push(['local-only', 'true']);
      } else {
        if (originalVisibility !== 'public') {
          tags.push(['visibility', originalVisibility]);
        }
      }
      
      // Preserve project-relay tags
      for (const relay of originalProjectRelays) {
        tags.push(['project-relay', relay]);
      }

      // Add earliest unique commit if available
      if (earliestCommit) {
        tags.push(['r', earliestCommit, 'euc']);
      }

      // Redirect to signup page with fork information pre-filled
      // The signup page will handle signing and publishing the fork announcement
      const signupUrl = new URL('/signup', event.url.origin);
      signupUrl.searchParams.set('npub', userNpub);
      signupUrl.searchParams.set('repo', forkRepoName);
      signupUrl.searchParams.set('fork', 'true');
      signupUrl.searchParams.set('forkOriginalRepo', originalRepoTag);
      signupUrl.searchParams.set('forkName', originalName); // Don't append "(fork)" to the name
      signupUrl.searchParams.set('forkDescription', `Fork of ${originalName}${originalDescription ? `: ${originalDescription}` : ''}`);
      if (isLocalOnly) {
        signupUrl.searchParams.set('localOnly', 'true');
      }
      // Add clone URLs as comma-separated list
      if (forkCloneUrls.length > 0) {
        signupUrl.searchParams.set('cloneUrls', forkCloneUrls.join(','));
      }
      // Add visibility
      if (isLocalOnly || originalVisibility !== 'public') {
        signupUrl.searchParams.set('visibility', isLocalOnly ? 'private' : originalVisibility);
      }
      // Add project relays
      if (originalProjectRelays.length > 0) {
        signupUrl.searchParams.set('projectRelays', originalProjectRelays.join(','));
      }
      // Add earliest commit
      if (earliestCommit) {
        signupUrl.searchParams.set('earliestCommit', earliestCommit);
      }
      
      logger.info({
        operation: 'fork',
        originalRepo: `${context.npub}/${context.repo}`,
        forkRepo: `${userNpub}/${forkRepoName}`,
        signupUrl: signupUrl.toString()
      }, 'Fork repository cloned, redirecting to signup page for announcement publishing');

      return json({
        success: true,
        redirect: signupUrl.toString(),
        fork: {
          npub: userNpub,
          repo: forkRepoName,
          url: forkGitUrl,
          localOnly: isLocalOnly
        },
        message: 'Fork repository created! Please sign and publish the fork announcement on the next page.'
      });
    } catch (err) {
      return handleApiError(err, { operation: 'createFork', npub: context.npub, repo: context.repo }, 'Failed to fork repository');
    }
  },
  { operation: 'createFork', requireRepoExists: false, requireMaintainer: false }
);
