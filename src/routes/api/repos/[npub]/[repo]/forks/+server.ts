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
import { existsSync } from 'fs';
import { rm } from 'fs/promises';
import { join, resolve } from 'path';
import simpleGit from 'simple-git';
import { validateRepoPath } from '$lib/utils/security.js';
import { ResourceLimits } from '$lib/services/security/resource-limits.js';
import { auditLogger } from '$lib/services/security/audit-logger.js';
import { ForkCountService } from '$lib/services/nostr/fork-count-service.js';
import { getCachedUserLevel } from '$lib/services/security/user-level-cache.js';
import { hasUnlimitedAccess } from '$lib/utils/user-access.js';
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
      const { userPubkey, forkName, localOnly } = body;

      if (!userPubkey) {
        return error(401, 'Authentication required. Please provide userPubkey.');
      }
      
      const isLocalOnly = localOnly === true;
      const originalOwnerPubkey = context.repoOwnerPubkey;

      // Decode user pubkey
      const userPubkeyHex = decodeNpubToHex(userPubkey) || userPubkey;
      const userNpub = nip19.npubEncode(userPubkeyHex);
      
      // Determine fork name
      const forkRepoName = forkName || context.repo;

      // Check if user has unlimited access
      const userLevel = getCachedUserLevel(userPubkeyHex);
      if (!hasUnlimitedAccess(userLevel?.level)) {
        const clientIp = event.request.headers.get('x-forwarded-for') || event.request.headers.get('x-real-ip') || 'unknown';
        auditLogger.logRepoFork(
          userPubkeyHex,
          `${context.npub}/${context.repo}`,
          `${userNpub}/${forkRepoName}`,
          'failure',
          'User does not have unlimited access'
        );
        return error(403, 'Repository creation requires unlimited access. Please verify you can write to at least one default Nostr relay.');
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

      // Check if original repo exists
      const originalRepoPath = join(repoRoot, context.npub, `${context.repo}.git`);
      const originalPathValidation = validateRepoPath(originalRepoPath, repoRoot);
      if (!originalPathValidation.valid) {
        return error(403, originalPathValidation.error || 'Invalid repository path');
      }
      if (!existsSync(originalRepoPath)) {
        return error(404, 'Original repository not found');
      }

      // Get original repo announcement
      const allAnnouncements = await fetchRepoAnnouncementsWithCache(nostrClient, originalOwnerPubkey, eventCache);
      const originalAnnouncement = findRepoAnnouncement(allAnnouncements, context.repo);

      if (!originalAnnouncement) {
        return error(404, 'Original repository announcement not found');
      }

      // Check if fork already exists
      const forkRepoPath = join(repoRoot, userNpub, `${forkRepoName}.git`);
      const forkPathValidation = validateRepoPath(forkRepoPath, repoRoot);
      if (!forkPathValidation.valid) {
        return error(403, forkPathValidation.error || 'Invalid fork repository path');
      }
      if (existsSync(forkRepoPath)) {
        return error(409, 'Fork already exists');
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
      await git.clone(originalRepoPath, forkRepoPath, ['--bare']);
      
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

      // Extract original clone URLs
      const originalCloneUrls = originalAnnouncement.tags
        .filter(t => t[0] === 'clone')
        .flatMap(t => t.slice(1))
        .filter(url => url && typeof url === 'string')
        .filter(url => {
          if (url.includes(gitDomain)) return false;
          if (url.includes('.onion')) return false;
          return true;
        }) as string[];

      const earliestCommitTag = originalAnnouncement.tags.find(t => t[0] === 'r' && t[2] === 'euc');
      const earliestCommit = earliestCommitTag?.[1];

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
      
      forkCloneUrls.push(...originalCloneUrls);

      // Validate: If using localhost, require either Tor .onion URL or at least one other clone URL
      if (isLocalhost && !torOnionUrl && originalCloneUrls.length === 0) {
        return error(400, 'Cannot create fork with only localhost. The original repository must have at least one public clone URL, or you need to configure a Tor .onion address.');
      }

      // Preserve visibility and project-relay from original repo
      const originalVisibility = getVisibility(originalAnnouncement);
      const originalProjectRelays = getProjectRelays(originalAnnouncement);
      
      // Build fork announcement tags
      const originalRepoTag = `${KIND.REPO_ANNOUNCEMENT}:${originalOwnerPubkey}:${context.repo}`;
      const tags: string[][] = [
        ['d', forkRepoName],
        ['name', `${originalName} (fork)`],
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

      // Create fork announcement event
      const forkAnnouncementTemplate = {
        kind: KIND.REPO_ANNOUNCEMENT,
        pubkey: userPubkeyHex,
        created_at: Math.floor(Date.now() / 1000),
        content: '',
        tags
      };

      // Sign fork announcement
      const signedForkAnnouncement = await signEventWithNIP07(forkAnnouncementTemplate);
      
      const truncatedNpub = userNpub.length > 16 ? `${userNpub.slice(0, 12)}...` : userNpub;
      const truncatedOriginalNpub = context.npub.length > 16 ? `${context.npub.slice(0, 12)}...` : context.npub;
      const logContext = `[${truncatedOriginalNpub}/${context.repo} → ${truncatedNpub}/${forkRepoName}]`;
      
      let publishResult: { success: string[]; failed: Array<{ relay: string; error: string }> } | null = null;
      let ownershipPublishResult: { success: string[]; failed: Array<{ relay: string; error: string }> } | null = null;
      let signedOwnershipEvent: NostrEvent | null = null;

      if (isLocalOnly) {
        // Local-only fork: Skip publishing to Nostr relays
        logger.info({ operation: 'fork', originalRepo: `${context.npub}/${context.repo}`, forkRepo: `${userNpub}/${forkRepoName}`, localOnly: true }, 'Creating local-only fork (not publishing to Nostr)');
        publishResult = { success: [], failed: [] };
        ownershipPublishResult = { success: [], failed: [] };
        
        // Create synthetic ownership event
        const ownershipService = new OwnershipTransferService([]);
        const initialOwnershipEvent = ownershipService.createInitialOwnershipEvent(userPubkeyHex, forkRepoName);
        signedOwnershipEvent = await signEventWithNIP07(initialOwnershipEvent);
      } else {
        // Public fork: Publish to Nostr relays
        const { outbox } = await getUserRelays(userPubkeyHex, nostrClient);
        const combinedRelays = combineRelays(outbox);
        
        logger.info({ operation: 'fork', originalRepo: `${context.npub}/${context.repo}`, forkRepo: `${userNpub}/${forkRepoName}`, relayCount: combinedRelays.length }, 'Starting fork process');

        publishResult = await publishEventWithRetry(
          signedForkAnnouncement,
          combinedRelays,
          'fork announcement',
          3,
          logContext
        );

        if (publishResult.success.length === 0) {
          logger.error({ operation: 'fork', originalRepo: `${context.npub}/${context.repo}`, forkRepo: `${userNpub}/${forkRepoName}`, failed: publishResult.failed }, 'Fork announcement failed after all retries. Cleaning up repository.');
          await rm(forkRepoPath, { recursive: true, force: true }).catch(() => {});
          const errorDetails = `All relays failed: ${publishResult.failed.map(f => `${f.relay}: ${f.error}`).join('; ')}`;
          return json({
            success: false,
            error: 'Failed to publish fork announcement to relays after 3 attempts',
            details: errorDetails,
            eventName: 'fork announcement'
          }, { status: 500 });
        }

        // Create and publish initial ownership proof
        const ownershipService = new OwnershipTransferService(combinedRelays);
        const initialOwnershipEvent = ownershipService.createInitialOwnershipEvent(userPubkeyHex, forkRepoName);
        signedOwnershipEvent = await signEventWithNIP07(initialOwnershipEvent);
        
        ownershipPublishResult = await publishEventWithRetry(
          signedOwnershipEvent,
          combinedRelays,
          'ownership transfer event',
          3,
          logContext
        );

        if (ownershipPublishResult.success.length === 0) {
          logger.error({ operation: 'fork', originalRepo: `${context.npub}/${context.repo}`, forkRepo: `${userNpub}/${forkRepoName}`, failed: ownershipPublishResult.failed }, 'Ownership transfer event failed after all retries. Cleaning up repository.');
          await rm(forkRepoPath, { recursive: true, force: true }).catch(() => {});
          
          // Publish deletion request (NIP-09)
          logger.info({ operation: 'fork', originalRepo: `${context.npub}/${context.repo}`, forkRepo: `${userNpub}/${forkRepoName}` }, 'Publishing deletion request for invalid fork announcement...');
          const deletionRequest = {
            kind: KIND.DELETION_REQUEST,
            pubkey: userPubkeyHex,
            created_at: Math.floor(Date.now() / 1000),
            content: 'Fork failed: ownership transfer event could not be published after 3 attempts. This announcement is invalid.',
            tags: [
              ['a', `${KIND.REPO_ANNOUNCEMENT}:${userPubkeyHex}:${forkRepoName}`],
              ['k', KIND.REPO_ANNOUNCEMENT.toString()]
            ]
          };
          
          const signedDeletionRequest = await signEventWithNIP07(deletionRequest);
          const deletionResult = await publishEventWithRetry(
            signedDeletionRequest,
            combinedRelays,
            'deletion request',
            3,
            logContext
          );
          
          const errorDetails = `Fork is invalid without ownership proof. All relays failed: ${ownershipPublishResult.failed.map(f => `${f.relay}: ${f.error}`).join('; ')}. Deletion request ${deletionResult.success.length > 0 ? 'published' : 'failed to publish'}.`;
          return json({
            success: false,
            error: 'Failed to publish ownership transfer event to relays after 3 attempts',
            details: errorDetails,
            eventName: 'ownership transfer event'
          }, { status: 500 });
        }
      }

      // Provision the fork repo
      logger.info({ operation: 'fork', originalRepo: `${context.npub}/${context.repo}`, forkRepo: `${userNpub}/${forkRepoName}`, localOnly: isLocalOnly }, 'Provisioning fork repository...');
      await repoManager.provisionRepo(signedForkAnnouncement, signedOwnershipEvent || undefined, false);

      logger.info({
        operation: 'fork',
        originalRepo: `${context.npub}/${context.repo}`,
        forkRepo: `${userNpub}/${forkRepoName}`,
        localOnly: isLocalOnly,
        announcementId: signedForkAnnouncement.id,
        ownershipTransferId: signedOwnershipEvent?.id,
        announcementRelays: publishResult?.success.length || 0,
        ownershipRelays: ownershipPublishResult?.success.length || 0
      }, 'Fork completed successfully');

      const message = isLocalOnly
        ? 'Local-only fork created successfully! This fork is private and only exists on this server.'
        : `Repository forked successfully! Published to ${publishResult?.success.length || 0} relay(s) for announcement and ${ownershipPublishResult?.success.length || 0} relay(s) for ownership proof.`;

      return json({
        success: true,
        fork: {
          npub: userNpub,
          repo: forkRepoName,
          url: forkGitUrl,
          localOnly: isLocalOnly,
          announcementId: signedForkAnnouncement.id,
          ownershipTransferId: signedOwnershipEvent?.id,
          publishedTo: isLocalOnly ? null : {
            announcement: publishResult?.success.length || 0,
            ownershipTransfer: ownershipPublishResult?.success.length || 0
          }
        },
        message
      });
    } catch (err) {
      return handleApiError(err, { operation: 'createFork', npub: context.npub, repo: context.repo }, 'Failed to fork repository');
    }
  },
  { operation: 'createFork', requireRepoExists: false, requireMaintainer: false }
);
