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

const repoRoot = process.env.GIT_REPO_ROOT || '/repos';
const fileManager = new FileManager(repoRoot);
const maintainerService = new MaintainerService(DEFAULT_NOSTR_RELAYS);

export const GET: RequestHandler = async ({ params, url, request }: { params: { npub?: string; repo?: string }; url: URL; request: Request }) => {
  const { npub, repo } = params;
  const userPubkey = url.searchParams.get('userPubkey') || request.headers.get('x-user-pubkey');

  if (!npub || !repo) {
    return error(400, 'Missing npub or repo parameter');
  }

  try {
    if (!fileManager.repoExists(npub, repo)) {
      return error(404, 'Repository not found');
    }

    // Check repository privacy
    const { checkRepoAccess } = await import('$lib/utils/repo-privacy.js');
    const access = await checkRepoAccess(npub, repo, userPubkey || null);
    if (!access.allowed) {
      return error(403, access.error || 'Access denied');
    }

    const tags = await fileManager.getTags(npub, repo);
    return json(tags);
  } catch (err) {
    console.error('Error getting tags:', err);
    return error(500, err instanceof Error ? err.message : 'Failed to get tags');
  }
};

export const POST: RequestHandler = async ({ params, request }: { params: { npub?: string; repo?: string }; request: Request }) => {
  const { npub, repo } = params;

  if (!npub || !repo) {
    return error(400, 'Missing npub or repo parameter');
  }

  try {
    const body = await request.json();
    const { tagName, ref, message, userPubkey } = body;

    if (!tagName) {
      return error(400, 'Missing tagName parameter');
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
      return error(403, 'Only repository maintainers can create tags.');
    }

    await fileManager.createTag(npub, repo, tagName, ref || 'HEAD', message);
    return json({ success: true, message: 'Tag created successfully' });
  } catch (err) {
    console.error('Error creating tag:', err);
    return error(500, err instanceof Error ? err.message : 'Failed to create tag');
  }
};
