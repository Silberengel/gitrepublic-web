/**
 * RESTful Transfers Resource Endpoint
 * 
 * GET    /api/repos/{npub}/{repo}/transfers             # Get transfer history
 * POST   /api/repos/{npub}/{repo}/transfers             # Transfer ownership
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createRepoGetHandler, createRepoPostHandler } from '$lib/utils/api-handlers.js';
import type { RepoRequestContext, RequestEvent } from '$lib/utils/api-context.js';
import { handleApiError, handleValidationError, handleAuthorizationError } from '$lib/utils/error-handler.js';
import { verifyEvent } from 'nostr-tools';
import { KIND } from '$lib/types/nostr.js';
import { ownershipTransferService, nostrClient, fileManager } from '$lib/services/service-registry.js';
import { withRepoValidation } from '$lib/utils/api-handlers.js';
import { combineRelays } from '$lib/config.js';
import { getUserRelays } from '$lib/services/nostr/user-relays.js';
import type { NostrEvent } from '$lib/types/nostr.js';
import logger from '$lib/services/logger.js';

/**
 * GET: Get transfer history
 */
export const GET: RequestHandler = createRepoGetHandler(
  async (context: RepoRequestContext) => {
    try {
      // Get current owner (may be different if transferred)
      const currentOwner = await ownershipTransferService.getCurrentOwner(context.repoOwnerPubkey, context.repo);

      // Fetch transfer events for history
      const repoTag = `${KIND.REPO_ANNOUNCEMENT}:${context.repoOwnerPubkey}:${context.repo}`;
      const transferEvents = await nostrClient.fetchEvents([
        {
          kinds: [KIND.OWNERSHIP_TRANSFER],
          '#a': [repoTag],
          limit: 100
        }
      ]);

      // Sort by created_at descending
      transferEvents.sort((a, b) => b.created_at - a.created_at);

      return json({
        originalOwner: context.repoOwnerPubkey,
        currentOwner,
        transferred: currentOwner !== context.repoOwnerPubkey,
        transfers: transferEvents.map(event => {
          const pTag = event.tags.find(t => t[0] === 'p');
          return {
            eventId: event.id,
            from: event.pubkey,
            to: pTag?.[1] || 'unknown',
            timestamp: event.created_at,
            createdAt: new Date(event.created_at * 1000).toISOString()
          };
        })
      });
    } catch (err) {
      return handleApiError(err, { operation: 'getTransferHistory', npub: context.npub, repo: context.repo }, 'Failed to get transfer history');
    }
  },
  { operation: 'getTransferHistory', requireRepoExists: false, requireRepoAccess: false }
);

/**
 * POST: Transfer ownership
 * Body: { transferEvent }
 */
export const POST: RequestHandler = withRepoValidation(
  async ({ repoContext, requestContext, event }) => {
    if (!requestContext.userPubkeyHex) {
      throw handleApiError(new Error('Authentication required'), { operation: 'transferOwnership', npub: repoContext.npub, repo: repoContext.repo }, 'Authentication required');
    }

    const body = await event.request.json();
    const { transferEvent } = body;

    if (!transferEvent) {
      return handleValidationError('Missing transferEvent in request body', { operation: 'transferOwnership', npub: repoContext.npub, repo: repoContext.repo });
    }

    // Verify the event is properly signed
    if (!transferEvent.sig || !transferEvent.id) {
      throw handleValidationError('Invalid event: missing signature or ID', { operation: 'transferOwnership', npub: repoContext.npub, repo: repoContext.repo });
    }

    if (!verifyEvent(transferEvent)) {
      throw handleValidationError('Invalid event signature', { operation: 'transferOwnership', npub: repoContext.npub, repo: repoContext.repo });
    }

    // Verify user is the current owner
    const canTransfer = await ownershipTransferService.canTransfer(
      requestContext.userPubkeyHex,
      repoContext.repoOwnerPubkey,
      repoContext.repo
    );

    if (!canTransfer) {
      throw handleAuthorizationError('Only the current repository owner can transfer ownership', { operation: 'transferOwnership', npub: repoContext.npub, repo: repoContext.repo });
    }

    // Verify the transfer event is from the current owner
    if (transferEvent.pubkey !== requestContext.userPubkeyHex) {
      throw handleAuthorizationError('Transfer event must be signed by the current owner', { operation: 'transferOwnership', npub: repoContext.npub, repo: repoContext.repo });
    }

    // Verify it's an ownership transfer event
    if (transferEvent.kind !== KIND.OWNERSHIP_TRANSFER) {
      throw handleValidationError(`Event must be kind ${KIND.OWNERSHIP_TRANSFER} (ownership transfer)`, { operation: 'transferOwnership', npub: repoContext.npub, repo: repoContext.repo });
    }

    // Verify the 'a' tag references this repo
    const aTag = transferEvent.tags.find(t => t[0] === 'a');
    const expectedRepoTag = `${KIND.REPO_ANNOUNCEMENT}:${repoContext.repoOwnerPubkey}:${repoContext.repo}`;
    if (!aTag || aTag[1] !== expectedRepoTag) {
      throw handleValidationError(`Transfer event must reference this repository: ${expectedRepoTag}`, { operation: 'transferOwnership', npub: repoContext.npub, repo: repoContext.repo });
    }

    // Get user's relays and publish
    const { outbox } = await getUserRelays(requestContext.userPubkeyHex, nostrClient);
    const combinedRelays = combineRelays(outbox);

    const result = await nostrClient.publishEvent(transferEvent as NostrEvent, combinedRelays);

    if (result.success.length === 0) {
      throw handleApiError(new Error('Failed to publish transfer event to any relays'), { operation: 'transferOwnership', npub: repoContext.npub, repo: repoContext.repo }, 'Failed to publish transfer event to any relays');
    }

    // Save transfer event to repo (offline papertrail)
    try {
      // Save to repo if it exists locally
      if (fileManager.repoExists(repoContext.npub, repoContext.repo)) {
        const defaultBranch = await fileManager.getDefaultBranch(repoContext.npub, repoContext.repo).catch(() => 'main');
        const repoPath = fileManager.getRepoPath(repoContext.npub, repoContext.repo);
        const workDir = await fileManager.getWorktree(repoPath, defaultBranch, repoContext.npub, repoContext.repo);
        
        // Save to repo-events.jsonl
        await fileManager.saveRepoEventToWorktree(workDir, transferEvent as NostrEvent, 'transfer').catch(err => {
          logger.debug({ error: err }, 'Failed to save transfer event to repo-events.jsonl');
        });
        
        // Clean up worktree
        await fileManager.removeWorktree(repoPath, workDir).catch(err => {
          logger.debug({ error: err }, 'Failed to remove worktree after saving transfer event');
        });
      } else {
        logger.debug({ npub: repoContext.npub, repo: repoContext.repo }, 'Repo does not exist locally, skipping transfer event save to repo');
      }
    } catch (err) {
      logger.warn({ error: err, npub: repoContext.npub, repo: repoContext.repo }, 'Failed to save transfer event to repo');
    }

    // Clear cache so new owner is recognized immediately
    ownershipTransferService.clearCache(repoContext.repoOwnerPubkey, repoContext.repo);

    return json({
      success: true,
      event: transferEvent,
      published: result,
      message: 'Ownership transfer initiated successfully',
      transferEvent: {
        id: transferEvent.id,
        from: transferEvent.pubkey,
        to: aTag[2] || 'unknown'
      }
    });
  }
);
