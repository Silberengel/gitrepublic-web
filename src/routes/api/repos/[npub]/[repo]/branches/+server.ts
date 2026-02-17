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
import { requireNpubHex, decodeNpubToHex } from '$lib/utils/npub-utils.js';
import { handleApiError, handleValidationError, handleNotFoundError, handleAuthError, handleAuthorizationError } from '$lib/utils/error-handler.js';

const repoRoot = process.env.GIT_REPO_ROOT || '/repos';
const fileManager = new FileManager(repoRoot);
const maintainerService = new MaintainerService(DEFAULT_NOSTR_RELAYS);

export const GET: RequestHandler = async ({ params }: { params: { npub?: string; repo?: string } }) => {
  const { npub, repo } = params;

  if (!npub || !repo) {
    return handleValidationError('Missing npub or repo parameter', { operation: 'getBranches' });
  }

  try {
    if (!fileManager.repoExists(npub, repo)) {
      return handleNotFoundError('Repository not found', { operation: 'getBranches', npub, repo });
    }

    const branches = await fileManager.getBranches(npub, repo);
    return json(branches);
  } catch (err) {
    return handleApiError(err, { operation: 'getBranches', npub, repo }, 'Failed to get branches');
  }
};

export const POST: RequestHandler = async ({ params, request }: { params: { npub?: string; repo?: string }; request: Request }) => {
  const { npub, repo } = params;

  if (!npub || !repo) {
    return handleValidationError('Missing npub or repo parameter', { operation: 'createBranch' });
  }

  let branchName: string | undefined;
  let fromBranch: string | undefined;
  let userPubkey: string | undefined;
  try {
    const body = await request.json();
    ({ branchName, fromBranch, userPubkey } = body);

    if (!branchName) {
      return handleValidationError('Missing branchName parameter', { operation: 'createBranch', npub, repo });
    }

    if (!userPubkey) {
      return handleAuthError('Authentication required. Please provide userPubkey.', { operation: 'createBranch', npub, repo });
    }

    if (!fileManager.repoExists(npub, repo)) {
      return handleNotFoundError('Repository not found', { operation: 'createBranch', npub, repo });
    }

    // Check if user is a maintainer
    let repoOwnerPubkey: string;
    try {
      repoOwnerPubkey = requireNpubHex(npub);
    } catch {
      return handleValidationError('Invalid npub format', { operation: 'createBranch', npub });
    }

    // Convert userPubkey to hex if needed
    const userPubkeyHex = decodeNpubToHex(userPubkey) || userPubkey;

    const isMaintainer = await maintainerService.isMaintainer(userPubkeyHex, repoOwnerPubkey, repo);
    if (!isMaintainer) {
      return handleAuthorizationError('Only repository maintainers can create branches. Please submit a pull request instead.', { operation: 'createBranch', npub, repo });
    }

    await fileManager.createBranch(npub, repo, branchName, fromBranch || 'main');
    return json({ success: true, message: 'Branch created successfully' });
  } catch (err) {
    return handleApiError(err, { operation: 'createBranch', npub, repo, branchName }, 'Failed to create branch');
  }
};
