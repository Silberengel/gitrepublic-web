/**
 * API endpoint for transferring repository ownership
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ownershipTransferService, nostrClient, fileManager } from '$lib/services/service-registry.js';
import { combineRelays } from '$lib/config.js';
import { KIND } from '$lib/types/nostr.js';
import { verifyEvent, nip19 } from 'nostr-tools';
import type { NostrEvent } from '$lib/types/nostr.js';
import { getUserRelays } from '$lib/services/nostr/user-relays.js';
import { createRepoGetHandler, withRepoValidation } from '$lib/utils/api-handlers.js';
import type { RepoRequestContext } from '$lib/utils/api-context.js';
import type { RequestEvent } from '@sveltejs/kit';
import { handleApiError, handleValidationError, handleAuthorizationError } from '$lib/utils/error-handler.js';
import logger from '$lib/services/logger.js';

/**
 * GET - Get current owner and transfer history
 */
export const GET: RequestHandler = createRepoGetHandler(
  async (context: RepoRequestContext) => {
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
  },
  { operation: 'getOwnership', requireRepoAccess: false } // Ownership info is public
);

/**
 * POST - Initiate ownership transfer
 * Requires a pre-signed NIP-98 authenticated event from the current owner
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
      throw handleValidationError("Transfer event 'a' tag does not match this repository", { operation: 'transferOwnership', npub: repoContext.npub, repo: repoContext.repo });
    }

    // Get user's relays and publish
    const { outbox } = await getUserRelays(requestContext.userPubkeyHex, nostrClient);
    const combinedRelays = combineRelays(outbox);

    const result = await nostrClient.publishEvent(transferEvent as NostrEvent, combinedRelays);

    if (result.success.length === 0) {
      throw handleApiError(new Error('Failed to publish transfer event to any relays'), { operation: 'transferOwnership', npub: repoContext.npub, repo: repoContext.repo }, 'Failed to publish transfer event to any relays');
    }

    // Save transfer event to repo (offline papertrail - step 1 requirement)
    try {
      const transferEventContent = JSON.stringify(transferEvent, null, 2) + '\n';
      // Use consistent filename pattern: .nostr-ownership-transfer-{eventId}.json
      const transferFileName = `.nostr-ownership-transfer-${transferEvent.id}.json`;
      
      // Save to repo if it exists locally
      if (fileManager.repoExists(repoContext.npub, repoContext.repo)) {
        // Get worktree to save to repo-events.jsonl
        const defaultBranch = await fileManager.getDefaultBranch(repoContext.npub, repoContext.repo).catch(() => 'main');
        const repoPath = fileManager.getRepoPath(repoContext.npub, repoContext.repo);
        const workDir = await fileManager.getWorktree(repoPath, defaultBranch, repoContext.npub, repoContext.repo);
        
        // Save to repo-events.jsonl (standard file for easy analysis)
        await fileManager.saveRepoEventToWorktree(workDir, transferEvent as NostrEvent, 'transfer').catch(err => {
          logger.debug({ error: err }, 'Failed to save transfer event to repo-events.jsonl');
        });
        
        // Also save individual transfer file
        await fileManager.writeFile(
          repoContext.npub,
          repoContext.repo,
          transferFileName,
          transferEventContent,
          `Add ownership transfer event: ${transferEvent.id.slice(0, 16)}...`,
          'Nostr',
          `${requestContext.userPubkeyHex}@nostr`,
          defaultBranch
        ).catch(err => {
          // Log but don't fail - publishing to relays is more important
          logger.warn({ error: err, npub: repoContext.npub, repo: repoContext.repo }, 'Failed to save transfer event to repo');
        });
        
        // Clean up worktree
        await fileManager.removeWorktree(repoPath, workDir).catch(err => {
          logger.debug({ error: err }, 'Failed to remove worktree after saving transfer event');
        });
      } else {
        logger.debug({ npub: repoContext.npub, repo: repoContext.repo }, 'Repo does not exist locally, skipping transfer event save to repo');
      }
    } catch (err) {
      // Log but don't fail - publishing to relays is more important
      logger.warn({ error: err, npub: repoContext.npub, repo: repoContext.repo }, 'Failed to save transfer event to repo');
    }

    // Clear cache so new owner is recognized immediately
    ownershipTransferService.clearCache(repoContext.repoOwnerPubkey, repoContext.repo);

    return json({
      success: true,
      event: transferEvent,
      published: result,
      message: 'Ownership transfer initiated successfully',
      // Signal to client that page should refresh
      refresh: true
    });
  },
  { operation: 'transferOwnership', requireRepoAccess: false } // Override to check owner instead
);
