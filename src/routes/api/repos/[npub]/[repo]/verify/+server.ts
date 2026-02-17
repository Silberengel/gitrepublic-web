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

    // Check for ownership transfer events (including self-transfer for initial ownership)
    const repoTag = `${KIND.REPO_ANNOUNCEMENT}:${context.repoOwnerPubkey}:${context.repo}`;
    const transferEvents = await nostrClient.fetchEvents([
      {
        kinds: [KIND.OWNERSHIP_TRANSFER],
        '#a': [repoTag],
        limit: 100
      }
    ]);

    // Look for self-transfer event (initial ownership proof)
    // Self-transfer: from owner to themselves, tagged with 'self-transfer'
    const selfTransfer = transferEvents.find(event => {
      const pTag = event.tags.find(t => t[0] === 'p');
      let toPubkey = pTag?.[1];
      
      // Decode npub if needed
      if (toPubkey) {
        try {
          toPubkey = decodeNpubToHex(toPubkey) || toPubkey;
        } catch {
          // Assume it's already hex
        }
      }
      
      return event.pubkey === context.repoOwnerPubkey && 
             toPubkey === context.repoOwnerPubkey;
    });

    // Verify ownership - prefer self-transfer event, fall back to verification file
    let verified = false;
    let verificationMethod = '';
    let verificationError: string | undefined;

    if (selfTransfer) {
      // Verify self-transfer event signature
      const { verifyEvent } = await import('nostr-tools');
      if (verifyEvent(selfTransfer)) {
        verified = true;
        verificationMethod = 'self-transfer-event';
      } else {
        verified = false;
        verificationError = 'Self-transfer event signature is invalid';
        verificationMethod = 'self-transfer-event';
      }
    } else {
      // Fall back to verification file method (for backward compatibility)
      try {
        const verificationFile = await fileManager.getFileContent(context.npub, context.repo, VERIFICATION_FILE_PATH, 'HEAD');
        const verification = verifyRepositoryOwnership(announcement, verificationFile.content);
        verified = verification.valid;
        verificationError = verification.error;
        verificationMethod = 'verification-file';
      } catch (err) {
        verified = false;
        verificationError = 'No ownership proof found (neither self-transfer event nor verification file)';
        verificationMethod = 'none';
      }
    }

    if (verified) {
      return json({
        verified: true,
        announcementId: announcement.id,
        ownerPubkey: context.repoOwnerPubkey,
        verificationMethod,
        selfTransferEventId: selfTransfer?.id,
        message: 'Repository ownership verified successfully'
      });
    } else {
      return json({
        verified: false,
        error: verificationError || 'Repository ownership verification failed',
        announcementId: announcement.id,
        verificationMethod,
        message: 'Repository ownership verification failed'
      });
    }
  },
  { operation: 'verifyRepo', requireRepoExists: false, requireRepoAccess: false } // Verification is public, doesn't need repo to exist
);
