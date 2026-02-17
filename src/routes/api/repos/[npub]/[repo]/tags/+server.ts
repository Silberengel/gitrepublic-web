/**
 * API endpoint for getting and creating tags
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

export const GET: RequestHandler = async ({ params, url, request }: { params: { npub?: string; repo?: string }; url: URL; request: Request }) => {
  const { npub, repo } = params;
  const userPubkey = url.searchParams.get('userPubkey') || request.headers.get('x-user-pubkey');

  if (!npub || !repo) {
    return handleValidationError('Missing npub or repo parameter', { operation: 'getTags' });
  }

  try {
    if (!fileManager.repoExists(npub, repo)) {
      return handleNotFoundError('Repository not found', { operation: 'getTags', npub, repo });
    }

    // Check repository privacy
    const { checkRepoAccess } = await import('$lib/utils/repo-privacy.js');
    const access = await checkRepoAccess(npub, repo, userPubkey || null);
    if (!access.allowed) {
      return handleAuthorizationError(access.error || 'Access denied', { operation: 'getTags', npub, repo });
    }

    const tags = await fileManager.getTags(npub, repo);
    return json(tags);
  } catch (err) {
    return handleApiError(err, { operation: 'getTags', npub, repo }, 'Failed to get tags');
  }
};

export const POST: RequestHandler = async ({ params, request }: { params: { npub?: string; repo?: string }; request: Request }) => {
  const { npub, repo } = params;

  if (!npub || !repo) {
    return handleValidationError('Missing npub or repo parameter', { operation: 'createTag' });
  }

  let tagName: string | undefined;
  let ref: string | undefined;
  let message: string | undefined;
  let userPubkey: string | undefined;
  try {
    const body = await request.json();
    ({ tagName, ref, message, userPubkey } = body);

    if (!tagName) {
      return handleValidationError('Missing tagName parameter', { operation: 'createTag', npub, repo });
    }

    if (!userPubkey) {
      return handleAuthError('Authentication required. Please provide userPubkey.', { operation: 'createTag', npub, repo });
    }

    if (!fileManager.repoExists(npub, repo)) {
      return handleNotFoundError('Repository not found', { operation: 'createTag', npub, repo });
    }

    // Check if user is a maintainer
    let repoOwnerPubkey: string;
    try {
      repoOwnerPubkey = requireNpubHex(npub);
    } catch {
      return handleValidationError('Invalid npub format', { operation: 'createTag', npub });
    }

    // Convert userPubkey to hex if needed
    const userPubkeyHex = decodeNpubToHex(userPubkey) || userPubkey;

    const isMaintainer = await maintainerService.isMaintainer(userPubkeyHex, repoOwnerPubkey, repo);
    if (!isMaintainer) {
      return handleAuthorizationError('Only repository maintainers can create tags.', { operation: 'createTag', npub, repo });
    }

    await fileManager.createTag(npub, repo, tagName, ref || 'HEAD', message);
    return json({ success: true, message: 'Tag created successfully' });
  } catch (err) {
    return handleApiError(err, { operation: 'createTag', npub, repo, tagName }, 'Failed to create tag');
  }
};
