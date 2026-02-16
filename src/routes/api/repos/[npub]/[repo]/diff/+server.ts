/**
 * API endpoint for getting diffs
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { FileManager } from '$lib/services/git/file-manager.js';

const repoRoot = process.env.GIT_REPO_ROOT || '/repos';
const fileManager = new FileManager(repoRoot);

export const GET: RequestHandler = async ({ params, url, request }) => {
  const { npub, repo } = params;
  const fromRef = url.searchParams.get('from');
  const toRef = url.searchParams.get('to') || 'HEAD';
  const filePath = url.searchParams.get('path') || undefined;
  const userPubkey = url.searchParams.get('userPubkey') || request.headers.get('x-user-pubkey');

  if (!npub || !repo || !fromRef) {
    return error(400, 'Missing npub, repo, or from parameter');
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

    const diffs = await fileManager.getDiff(npub, repo, fromRef, toRef, filePath);
    return json(diffs);
  } catch (err) {
    console.error('Error getting diff:', err);
    return error(500, err instanceof Error ? err.message : 'Failed to get diff');
  }
};
