/**
 * API endpoint for listing files and directories in a repository
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { FileManager } from '$lib/services/git/file-manager.js';

const repoRoot = process.env.GIT_REPO_ROOT || '/repos';
const fileManager = new FileManager(repoRoot);

export const GET: RequestHandler = async ({ params, url }) => {
  const { npub, repo } = params;
  const ref = url.searchParams.get('ref') || 'HEAD';
  const path = url.searchParams.get('path') || '';

  if (!npub || !repo) {
    return error(400, 'Missing npub or repo parameter');
  }

  try {
    if (!fileManager.repoExists(npub, repo)) {
      return error(404, 'Repository not found');
    }

    const files = await fileManager.listFiles(npub, repo, ref, path);
    return json(files);
  } catch (err) {
    console.error('Error listing files:', err);
    return error(500, err instanceof Error ? err.message : 'Failed to list files');
  }
};
