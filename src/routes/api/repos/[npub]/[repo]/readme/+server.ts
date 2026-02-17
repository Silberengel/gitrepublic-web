/**
 * API endpoint for getting README content
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { FileManager } from '$lib/services/git/file-manager.js';
import { MaintainerService } from '$lib/services/nostr/maintainer-service.js';
import { DEFAULT_NOSTR_RELAYS } from '$lib/config.js';
import { nip19 } from 'nostr-tools';
import logger from '$lib/services/logger.js';

const repoRoot = process.env.GIT_REPO_ROOT || '/repos';
const fileManager = new FileManager(repoRoot);
const maintainerService = new MaintainerService(DEFAULT_NOSTR_RELAYS);

const README_PATTERNS = [
  'README.md',
  'README.markdown',
  'README.txt',
  'readme.md',
  'readme.markdown',
  'readme.txt',
  'README',
  'readme'
];

export const GET: RequestHandler = async ({ params, url, request }) => {
  const { npub, repo } = params;
  const ref = url.searchParams.get('ref') || 'HEAD';
  const userPubkey = url.searchParams.get('userPubkey') || request.headers.get('x-user-pubkey');

  if (!npub || !repo) {
    return error(400, 'Missing npub or repo parameter');
  }

  try {
    if (!fileManager.repoExists(npub, repo)) {
      return error(404, 'Repository not found');
    }

    // Check repository privacy
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

    const canView = await maintainerService.canView(userPubkey || null, repoOwnerPubkey, repo);
    if (!canView) {
      return error(403, 'This repository is private. Only owners and maintainers can view it.');
    }

    // Try to find README file
    let readmeContent: string | null = null;
    let readmePath: string | null = null;

    for (const pattern of README_PATTERNS) {
      try {
        // Try root directory first
        const content = await fileManager.getFileContent(npub, repo, pattern, ref);
        readmeContent = content.content;
        readmePath = pattern;
        break;
      } catch {
        // Try in root directory with different paths
        try {
          const content = await fileManager.getFileContent(npub, repo, `/${pattern}`, ref);
          readmeContent = content.content;
          readmePath = `/${pattern}`;
          break;
        } catch {
          continue;
        }
      }
    }

    if (!readmeContent) {
      return json({ found: false });
    }

    return json({
      found: true,
      content: readmeContent,
      path: readmePath,
      isMarkdown: readmePath?.toLowerCase().endsWith('.md') || readmePath?.toLowerCase().endsWith('.markdown')
    });
  } catch (err) {
    logger.error({ error: err, npub, repo }, 'Error getting README');
    return error(500, err instanceof Error ? err.message : 'Failed to get README');
  }
};
