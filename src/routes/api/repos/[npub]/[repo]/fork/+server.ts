/**
 * API endpoint for forking repositories
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { RepoManager } from '$lib/services/git/repo-manager.js';
import { DEFAULT_NOSTR_RELAYS, combineRelays, getGitUrl } from '$lib/config.js';
import { getUserRelays } from '$lib/services/nostr/user-relays.js';
import { NostrClient } from '$lib/services/nostr/nostr-client.js';
import { KIND, type NostrEvent } from '$lib/types/nostr.js';
import { nip19 } from 'nostr-tools';
import { signEventWithNIP07 } from '$lib/services/nostr/nip07-signer.js';
import { OwnershipTransferService } from '$lib/services/nostr/ownership-transfer-service.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { join } from 'path';
import { ResourceLimits } from '$lib/services/security/resource-limits.js';
import { auditLogger } from '$lib/services/security/audit-logger.js';
import { ForkCountService } from '$lib/services/nostr/fork-count-service.js';
import logger from '$lib/services/logger.js';

const execAsync = promisify(exec);
const repoRoot = process.env.GIT_REPO_ROOT || '/repos';
const repoManager = new RepoManager(repoRoot);
const nostrClient = new NostrClient(DEFAULT_NOSTR_RELAYS);
const resourceLimits = new ResourceLimits(repoRoot);
const forkCountService = new ForkCountService(DEFAULT_NOSTR_RELAYS);

/**
 * Retry publishing an event with exponential backoff
 * Attempts up to 3 times with delays: 1s, 2s, 4s
 */
async function publishEventWithRetry(
  event: NostrEvent,
  relays: string[],
  eventName: string,
  maxAttempts: number = 3,
  context?: string
): Promise<{ success: string[]; failed: Array<{ relay: string; error: string }> }> {
  let lastResult: { success: string[]; failed: Array<{ relay: string; error: string }> } | null = null;
  
  // Extract context from event if available (for better logging)
  const eventId = event.id.slice(0, 8);
  const logContext = context || `[event:${eventId}]`;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    logger.info({ logContext, eventName, attempt, maxAttempts }, `[Fork] Publishing ${eventName} - Attempt ${attempt}/${maxAttempts}...`);
    
    lastResult = await nostrClient.publishEvent(event, relays);
    
    if (lastResult.success.length > 0) {
      logger.info({ logContext, eventName, successCount: lastResult.success.length, relays: lastResult.success }, `[Fork] ${eventName} published successfully`);
      if (lastResult.failed.length > 0) {
        logger.warn({ logContext, eventName, failed: lastResult.failed }, `[Fork] Some relays failed`);
      }
      return lastResult;
    }
    
    if (attempt < maxAttempts) {
      const delayMs = Math.pow(2, attempt - 1) * 1000; // 1s, 2s, 4s
      logger.warn({ logContext, eventName, attempt, delayMs, failed: lastResult.failed }, `[Fork] ${eventName} failed on attempt ${attempt}. Retrying...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  
  // All attempts failed
  logger.error({ logContext, eventName, maxAttempts, failed: lastResult?.failed }, `[Fork] ${eventName} failed after ${maxAttempts} attempts`);
  return lastResult!;
}

/**
 * POST - Fork a repository
 * Body: { userPubkey, forkName? }
 */
export const POST: RequestHandler = async ({ params, request }) => {
  const { npub, repo } = params;

  if (!npub || !repo) {
    return error(400, 'Missing npub or repo parameter');
  }

  try {
    const body = await request.json();
    const { userPubkey, forkName } = body;

    if (!userPubkey) {
      return error(401, 'Authentication required. Please provide userPubkey.');
    }

    // Decode original repo owner npub
    let originalOwnerPubkey: string;
    try {
      const decoded = nip19.decode(npub);
      if (decoded.type === 'npub') {
        originalOwnerPubkey = decoded.data as string;
      } else {
        return error(400, 'Invalid npub format');
      }
    } catch {
      return error(400, 'Invalid npub format');
    }

    // Decode user pubkey if needed (must be done before using it)
    let userPubkeyHex = userPubkey;
    try {
      const userDecoded = nip19.decode(userPubkey) as { type: string; data: unknown };
      // Type guard: check if it's an npub
      if (userDecoded.type === 'npub' && typeof userDecoded.data === 'string') {
        userPubkeyHex = userDecoded.data;
      }
      // If not npub, assume it's already hex
    } catch {
      // Assume it's already hex
    }

    // Convert to npub for resource check and path construction
    const userNpub = nip19.npubEncode(userPubkeyHex);
    
    // Determine fork name (use original name if not specified)
    const forkRepoName = forkName || repo;

    // Check resource limits before forking
    const resourceCheck = await resourceLimits.canCreateRepo(userNpub);
    if (!resourceCheck.allowed) {
      const clientIp = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';
      auditLogger.logRepoFork(
        userPubkeyHex,
        `${npub}/${repo}`,
        `${userNpub}/${forkRepoName}`,
        'failure',
        resourceCheck.reason
      );
      return error(403, resourceCheck.reason || 'Resource limit exceeded');
    }

    // Check if original repo exists
    const originalRepoPath = join(repoRoot, npub, `${repo}.git`);
    if (!existsSync(originalRepoPath)) {
      return error(404, 'Original repository not found');
    }

    // Get original repo announcement
    const originalAnnouncements = await nostrClient.fetchEvents([
      {
        kinds: [KIND.REPO_ANNOUNCEMENT],
        authors: [originalOwnerPubkey],
        '#d': [repo],
        limit: 1
      }
    ]);

    if (originalAnnouncements.length === 0) {
      return error(404, 'Original repository announcement not found');
    }

    const originalAnnouncement = originalAnnouncements[0];

    // Check if fork already exists
    const forkRepoPath = join(repoRoot, userNpub, `${forkRepoName}.git`);
    if (existsSync(forkRepoPath)) {
      return error(409, 'Fork already exists');
    }

    // Clone the repository
    const clientIp = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';
    auditLogger.logRepoFork(
      userPubkeyHex,
      `${npub}/${repo}`,
      `${userNpub}/${forkRepoName}`,
      'success'
    );
    
    await execAsync(`git clone --bare "${originalRepoPath}" "${forkRepoPath}"`);
    
    // Invalidate resource limit cache after creating repo
    resourceLimits.invalidateCache(userNpub);

    // Create fork announcement
    const gitDomain = process.env.GIT_DOMAIN || 'localhost:6543';
    const protocol = gitDomain.startsWith('localhost') ? 'http' : 'https';
    const forkGitUrl = `${protocol}://${gitDomain}/${userNpub}/${forkRepoName}.git`;

    // Extract original clone URLs and earliest unique commit
    const originalCloneUrls = originalAnnouncement.tags
      .filter(t => t[0] === 'clone')
      .flatMap(t => t.slice(1))
      .filter(url => url && typeof url === 'string') as string[];

    const earliestCommitTag = originalAnnouncement.tags.find(t => t[0] === 'r' && t[2] === 'euc');
    const earliestCommit = earliestCommitTag?.[1];

    // Get original repo name and description
    const originalName = originalAnnouncement.tags.find(t => t[0] === 'name')?.[1] || repo;
    const originalDescription = originalAnnouncement.tags.find(t => t[0] === 'description')?.[1] || '';

    // Build fork announcement tags
    const tags: string[][] = [
      ['d', forkRepoName],
      ['name', `${originalName} (fork)`],
      ['description', `Fork of ${originalName}${originalDescription ? `: ${originalDescription}` : ''}`],
      ['clone', forkGitUrl, ...originalCloneUrls.filter(url => !url.includes(gitDomain))],
      ['relays', ...DEFAULT_NOSTR_RELAYS],
      ['t', 'fork'], // Mark as fork
      ['a', `${KIND.REPO_ANNOUNCEMENT}:${originalOwnerPubkey}:${repo}`], // Reference to original repo
      ['p', originalOwnerPubkey], // Original owner
    ];

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

    // Sign and publish fork announcement
    const signedForkAnnouncement = await signEventWithNIP07(forkAnnouncementTemplate);
    
    const { outbox } = await getUserRelays(userPubkeyHex, nostrClient);
    const combinedRelays = combineRelays(outbox);

    // Security: Truncate npub in logs and create context (must be before use)
    const truncatedNpub = userNpub.length > 16 ? `${userNpub.slice(0, 12)}...` : userNpub;
    const truncatedOriginalNpub = npub.length > 16 ? `${npub.slice(0, 12)}...` : npub;
    const context = `[${truncatedOriginalNpub}/${repo} → ${truncatedNpub}/${forkRepoName}]`;
    
    const forkLogger = logger.child({ operation: 'fork', originalRepo: `${npub}/${repo}`, forkRepo: `${userNpub}/${forkRepoName}` });
    forkLogger.info({ relayCount: combinedRelays.length, relays: combinedRelays }, 'Starting fork process');

    const publishResult = await publishEventWithRetry(
      signedForkAnnouncement,
      combinedRelays,
      'fork announcement',
      3,
      context
    );

    if (publishResult.success.length === 0) {
      // Clean up repo if announcement failed
      forkLogger.error({ failed: publishResult.failed }, 'Fork announcement failed after all retries. Cleaning up repository.');
      await execAsync(`rm -rf "${forkRepoPath}"`).catch(() => {});
      const errorDetails = `All relays failed: ${publishResult.failed.map(f => `${f.relay}: ${f.error}`).join('; ')}`;
      return json({
        success: false,
        error: 'Failed to publish fork announcement to relays after 3 attempts',
        details: errorDetails,
        eventName: 'fork announcement'
      }, { status: 500 });
    }

    // Create and publish initial ownership proof (self-transfer event)
    // This MUST succeed for the fork to be valid - without it, there's no proof of ownership on Nostr
    const ownershipService = new OwnershipTransferService(combinedRelays);
    const initialOwnershipEvent = ownershipService.createInitialOwnershipEvent(userPubkeyHex, forkRepoName);
    const signedOwnershipEvent = await signEventWithNIP07(initialOwnershipEvent);
    
    const ownershipPublishResult = await publishEventWithRetry(
      signedOwnershipEvent,
      combinedRelays,
      'ownership transfer event',
      3,
      context
    );

    if (ownershipPublishResult.success.length === 0) {
      // Clean up repo if ownership proof failed
      forkLogger.error({ failed: ownershipPublishResult.failed }, 'Ownership transfer event failed after all retries. Cleaning up repository and publishing deletion request.');
      await execAsync(`rm -rf "${forkRepoPath}"`).catch(() => {});
      
      // Publish deletion request (NIP-09) for the announcement since it's invalid without ownership proof
      forkLogger.info('Publishing deletion request for invalid fork announcement...');
      const deletionRequest = {
        kind: KIND.DELETION_REQUEST, // NIP-09: Event Deletion Request
        pubkey: userPubkeyHex,
        created_at: Math.floor(Date.now() / 1000),
        content: 'Fork failed: ownership transfer event could not be published after 3 attempts. This announcement is invalid.',
        tags: [
          ['a', `${KIND.REPO_ANNOUNCEMENT}:${userPubkeyHex}:${forkRepoName}`], // Reference to the repo announcement
          ['k', KIND.REPO_ANNOUNCEMENT.toString()] // Kind of event being deleted
        ]
      };
      
      const signedDeletionRequest = await signEventWithNIP07(deletionRequest);
      const deletionResult = await publishEventWithRetry(
        signedDeletionRequest,
        combinedRelays,
        'deletion request',
        3,
        context
      );
      
      if (deletionResult.success.length > 0) {
        forkLogger.info('Deletion request published successfully');
      } else {
        forkLogger.error({ failed: deletionResult.failed }, 'Failed to publish deletion request');
      }
      
      const errorDetails = `Fork is invalid without ownership proof. All relays failed: ${ownershipPublishResult.failed.map(f => `${f.relay}: ${f.error}`).join('; ')}. Deletion request ${deletionResult.success.length > 0 ? 'published' : 'failed to publish'}.`;
      return json({
        success: false,
        error: 'Failed to publish ownership transfer event to relays after 3 attempts',
        details: errorDetails,
        eventName: 'ownership transfer event'
      }, { status: 500 });
    }

    // Provision the fork repo (this will create verification file and include self-transfer)
    forkLogger.info('Provisioning fork repository...');
    await repoManager.provisionRepo(signedForkAnnouncement, signedOwnershipEvent, false);

    forkLogger.info({
      announcementId: signedForkAnnouncement.id,
      ownershipTransferId: signedOwnershipEvent.id,
      announcementRelays: publishResult.success.length,
      ownershipRelays: ownershipPublishResult.success.length
    }, 'Fork completed successfully');

    return json({
      success: true,
      fork: {
        npub: userNpub,
        repo: forkRepoName,
        url: forkGitUrl,
        announcementId: signedForkAnnouncement.id,
        ownershipTransferId: signedOwnershipEvent.id,
        publishedTo: {
          announcement: publishResult.success.length,
          ownershipTransfer: ownershipPublishResult.success.length
        }
      },
      message: `Repository forked successfully! Published to ${publishResult.success.length} relay(s) for announcement and ${ownershipPublishResult.success.length} relay(s) for ownership proof.`
    });
  } catch (err) {
    // Security: Sanitize error messages to prevent leaking sensitive data
    const sanitizedError = err instanceof Error ? err.message.replace(/nsec[0-9a-z]+/gi, '[REDACTED]').replace(/[0-9a-f]{64}/g, '[REDACTED]') : 'Failed to fork repository';
    const context = npub && repo ? `[${npub}/${repo}]` : '[unknown]';
    logger.error({ error: sanitizedError, npub, repo }, `[Fork] ${context} Error forking repository`);
    return error(500, sanitizedError);
  }
};

/**
 * GET - Get fork information
 * Returns whether this is a fork and what it's forked from
 */
export const GET: RequestHandler = async ({ params }) => {
  const { npub, repo } = params;

  if (!npub || !repo) {
    return error(400, 'Missing npub or repo parameter');
  }

  try {
    // Decode repo owner npub
    let ownerPubkey: string;
    try {
      const decoded = nip19.decode(npub);
      if (decoded.type === 'npub') {
        ownerPubkey = decoded.data as string;
      } else {
        return error(400, 'Invalid npub format');
      }
    } catch {
      return error(400, 'Invalid npub format');
    }

    // Get repo announcement
    const announcements = await nostrClient.fetchEvents([
      {
        kinds: [KIND.REPO_ANNOUNCEMENT],
        authors: [ownerPubkey],
        '#d': [repo],
        limit: 1
      }
    ]);

    if (announcements.length === 0) {
      return error(404, 'Repository announcement not found');
    }

    const announcement = announcements[0];
    const isFork = announcement.tags.some(t => t[0] === 't' && t[1] === 'fork');
    
    // Get original repo reference
    const originalRepoTag = announcement.tags.find(t => t[0] === 'a' && t[1]?.startsWith(`${KIND.REPO_ANNOUNCEMENT}:`));
    const originalOwnerTag = announcement.tags.find(t => t[0] === 'p' && t[1] !== ownerPubkey);

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

    // Get fork count for this repo
    let forkCount = 0;
    if (!isFork && ownerPubkey && repo) {
      try {
        forkCount = await forkCountService.getForkCount(ownerPubkey, repo);
      } catch (err) {
        // Log but don't fail the request
        const context = npub && repo ? `[${npub}/${repo}]` : '[unknown]';
        logger.warn({ error: err, npub, repo }, `[Fork] ${context} Failed to get fork count`);
      }
    }

    return json({
      isFork,
      originalRepo,
      forkCount
    });
  } catch (err) {
    // Security: Sanitize error messages
    const sanitizedError = err instanceof Error ? err.message.replace(/nsec[0-9a-z]+/gi, '[REDACTED]').replace(/[0-9a-f]{64}/g, '[REDACTED]') : 'Failed to get fork information';
    const context = npub && repo ? `[${npub}/${repo}]` : '[unknown]';
    logger.error({ error: sanitizedError, npub, repo }, `[Fork] ${context} Error getting fork information`);
    return error(500, sanitizedError);
  }
};
