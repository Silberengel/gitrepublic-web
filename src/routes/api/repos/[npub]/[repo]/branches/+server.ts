/**
 * API endpoint for getting and creating repository branches
 */

import { json, error } from '@sveltejs/kit';
// @ts-ignore - SvelteKit generates this type
import type { RequestHandler } from './$types';
import { FileManager } from '$lib/services/git/file-manager.js';
import { MaintainerService } from '$lib/services/nostr/maintainer-service.js';
import { DEFAULT_NOSTR_RELAYS } from '$lib/config.js';
import { nip19 } from 'nostr-tools';
import logger from '$lib/services/logger.js';

const repoRoot = process.env.GIT_REPO_ROOT || '/repos';
const fileManager = new FileManager(repoRoot);
const maintainerService = new MaintainerService(DEFAULT_NOSTR_RELAYS);

export const GET: RequestHandler = async ({ params }: { params: { npub?: string; repo?: string } }) => {
  const { npub, repo } = params;

  if (!npub || !repo) {
    return error(400, 'Missing npub or repo parameter');
  }

  try {
    if (!fileManager.repoExists(npub, repo)) {
      return error(404, 'Repository not found');
    }

    const branches = await fileManager.getBranches(npub, repo);
    return json(branches);
  } catch (err) {
    logger.error({ error: err, npub, repo }, 'Error getting branches');
    return error(500, err instanceof Error ? err.message : 'Failed to get branches');
  }
};

export const POST: RequestHandler = async ({ params, request }: { params: { npub?: string; repo?: string }; request: Request }) => {
  const { npub, repo } = params;

  if (!npub || !repo) {
    return error(400, 'Missing npub or repo parameter');
  }

  try {
    const body = await request.json();
    const { branchName, fromBranch, userPubkey } = body;

    if (!branchName) {
      return error(400, 'Missing branchName parameter');
    }

    if (!userPubkey) {
      return error(401, 'Authentication required. Please provide userPubkey.');
    }

    if (!fileManager.repoExists(npub, repo)) {
      return error(404, 'Repository not found');
    }

    // Check if user is a maintainer
    let repoOwnerPubkey: string;
    try {
      const decoded = nip19.decode(npub);
      if (decoded.type === 'npub') {
        repoOwnerPubkey = decoded.data as string;
      } else {
        return error(400, 'Invalid npub format');
      }
    } catch {
      return error(400, 'Invalid npub format');
    }

    // Convert userPubkey to hex if needed
    let userPubkeyHex = userPubkey;
    try {
      const userDecoded = nip19.decode(userPubkey);
      // @ts-ignore - nip19 types are incomplete, but we know npub returns string
      if (userDecoded.type === 'npub') {
        userPubkeyHex = userDecoded.data as unknown as string;
      }
    } catch {
      // Assume it's already a hex pubkey
    }

    const isMaintainer = await maintainerService.isMaintainer(userPubkeyHex, repoOwnerPubkey, repo);
    if (!isMaintainer) {
      return error(403, 'Only repository maintainers can create branches. Please submit a pull request instead.');
    }

    await fileManager.createBranch(npub, repo, branchName, fromBranch || 'main');
    return json({ success: true, message: 'Branch created successfully' });
  } catch (err) {
    logger.error({ error: err, npub, repo, branchName }, 'Error creating branch');
    return error(500, err instanceof Error ? err.message : 'Failed to create branch');
  }
};
