/**
 * API endpoint for getting commit history
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { FileManager } from '$lib/services/git/file-manager.js';

const repoRoot = process.env.GIT_REPO_ROOT || '/repos';
const fileManager = new FileManager(repoRoot);

export const GET: RequestHandler = async ({ params, url }) => {
  const { npub, repo } = params;
  const branch = url.searchParams.get('branch') || 'main';
  const limit = parseInt(url.searchParams.get('limit') || '50', 10);
  const path = url.searchParams.get('path') || undefined;

  if (!npub || !repo) {
    return error(400, 'Missing npub or repo parameter');
  }

  try {
    if (!fileManager.repoExists(npub, repo)) {
      return error(404, 'Repository not found');
    }

    const commits = await fileManager.getCommitHistory(npub, repo, branch, limit, path);
    return json(commits);
  } catch (err) {
    console.error('Error getting commit history:', err);
    return error(500, err instanceof Error ? err.message : 'Failed to get commit history');
  }
};
