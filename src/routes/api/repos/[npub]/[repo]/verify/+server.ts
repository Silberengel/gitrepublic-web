/**
 * API endpoint for verifying repository ownership
 */

import { json, error } from '@sveltejs/kit';
// @ts-ignore - SvelteKit generates this type
import type { RequestHandler } from './$types';
import { FileManager } from '$lib/services/git/file-manager.js';
import { verifyRepositoryOwnership, VERIFICATION_FILE_PATH } from '$lib/services/nostr/repo-verification.js';
import { NostrClient } from '$lib/services/nostr/nostr-client.js';
import { DEFAULT_NOSTR_RELAYS } from '$lib/config.js';
import { KIND } from '$lib/types/nostr.js';
import { nip19 } from 'nostr-tools';
import { existsSync } from 'fs';
import { join } from 'path';

const repoRoot = process.env.GIT_REPO_ROOT || '/repos';
const fileManager = new FileManager(repoRoot);
const nostrClient = new NostrClient(DEFAULT_NOSTR_RELAYS);

export const GET: RequestHandler = async ({ params }: { params: { npub?: string; repo?: string } }) => {
  const { npub, repo } = params;

  if (!npub || !repo) {
    return error(400, 'Missing npub or repo parameter');
  }

  try {
    // Decode npub to get pubkey
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

    // Check if repository exists (using FileManager's internal method)
    const repoPath = join(repoRoot, npub, `${repo}.git`);
    if (!existsSync(repoPath)) {
      return error(404, 'Repository not found');
    }

    // Try to read verification file
    let verificationContent: string;
    try {
      const verificationFile = await fileManager.getFileContent(npub, repo, VERIFICATION_FILE_PATH, 'HEAD');
      verificationContent = verificationFile.content;
    } catch (err) {
      return json({
        verified: false,
        error: 'Verification file not found in repository',
        message: 'This repository does not have a .nostr-verification file. It may have been created before verification was implemented.'
      });
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

    // Verify ownership
    const verification = verifyRepositoryOwnership(announcement, verificationContent);

    if (verification.valid) {
      return json({
        verified: true,
        announcementId: announcement.id,
        ownerPubkey: ownerPubkey,
        message: 'Repository ownership verified successfully'
      });
    } else {
      return json({
        verified: false,
        error: verification.error,
        announcementId: announcement.id,
        message: 'Repository ownership verification failed'
      });
    }
  } catch (err) {
    console.error('Error verifying repository:', err);
    return error(500, err instanceof Error ? err.message : 'Failed to verify repository');
  }
};
