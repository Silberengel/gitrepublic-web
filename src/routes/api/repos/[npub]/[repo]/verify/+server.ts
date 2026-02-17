/**
 * API endpoint for verifying repository ownership
 */

import { json, error } from '@sveltejs/kit';
// @ts-ignore - SvelteKit generates this type
import type { RequestHandler } from './$types';
import { FileManager } from '$lib/services/git/file-manager.js';
import { verifyRepositoryOwnership, VERIFICATION_FILE_PATH } from '$lib/services/nostr/repo-verification.js';
import { NostrClient } from '$lib/services/nostr/nostr-client.js';
import { OwnershipTransferService } from '$lib/services/nostr/ownership-transfer-service.js';
import { DEFAULT_NOSTR_RELAYS } from '$lib/config.js';
import { KIND } from '$lib/types/nostr.js';
import { nip19 } from 'nostr-tools';
import { existsSync } from 'fs';
import logger from '$lib/services/logger.js';
import { join } from 'path';
import { requireNpubHex, decodeNpubToHex } from '$lib/utils/npub-utils.js';
import { handleApiError, handleValidationError, handleNotFoundError } from '$lib/utils/error-handler.js';

const repoRoot = process.env.GIT_REPO_ROOT || '/repos';
const fileManager = new FileManager(repoRoot);
const nostrClient = new NostrClient(DEFAULT_NOSTR_RELAYS);
const ownershipTransferService = new OwnershipTransferService(DEFAULT_NOSTR_RELAYS);

export const GET: RequestHandler = async ({ params }: { params: { npub?: string; repo?: string } }) => {
  const { npub, repo } = params;

  if (!npub || !repo) {
    return handleValidationError('Missing npub or repo parameter', { operation: 'verifyRepo' });
  }

  try {
    // Decode npub to get pubkey
    let ownerPubkey: string;
    try {
      ownerPubkey = requireNpubHex(npub);
    } catch {
      return handleValidationError('Invalid npub format', { operation: 'verifyRepo', npub });
    }

    // Check if repository exists (using FileManager's internal method)
    const repoPath = join(repoRoot, npub, `${repo}.git`);
    if (!existsSync(repoPath)) {
      return handleNotFoundError('Repository not found', { operation: 'verifyRepo', npub, repo });
    }

    // Fetch the repository announcement
    const events = await nostrClient.fetchEvents([
      {
        kinds: [KIND.REPO_ANNOUNCEMENT],
        authors: [ownerPubkey],
        '#d': [repo],
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
    const repoTag = `${KIND.REPO_ANNOUNCEMENT}:${ownerPubkey}:${repo}`;
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
      
      return event.pubkey === ownerPubkey && 
             toPubkey === ownerPubkey;
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
        const verificationFile = await fileManager.getFileContent(npub, repo, VERIFICATION_FILE_PATH, 'HEAD');
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
        ownerPubkey: ownerPubkey,
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
  } catch (err) {
    return handleApiError(err, { operation: 'verifyRepo', npub, repo }, 'Failed to verify repository');
  }
};
