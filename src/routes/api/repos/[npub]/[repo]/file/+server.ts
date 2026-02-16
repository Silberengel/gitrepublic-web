/**
 * API endpoint for reading and writing files in a repository
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

export const GET: RequestHandler = async ({ params, url }: { params: { npub?: string; repo?: string }; url: URL }) => {
  const { npub, repo } = params;
  const filePath = url.searchParams.get('path');
  const ref = url.searchParams.get('ref') || 'HEAD';

  if (!npub || !repo || !filePath) {
    return error(400, 'Missing npub, repo, or path parameter');
  }

  try {
    if (!fileManager.repoExists(npub, repo)) {
      return error(404, 'Repository not found');
    }

    const fileContent = await fileManager.getFileContent(npub, repo, filePath, ref);
    return json(fileContent);
  } catch (err) {
    console.error('Error reading file:', err);
    return error(500, err instanceof Error ? err.message : 'Failed to read file');
  }
};

export const POST: RequestHandler = async ({ params, request }: { params: { npub?: string; repo?: string }; request: Request }) => {
  const { npub, repo } = params;

  if (!npub || !repo) {
    return error(400, 'Missing npub or repo parameter');
  }

  try {
    const body = await request.json();
    const { path, content, commitMessage, authorName, authorEmail, branch, action, userPubkey } = body;

    if (!path || !commitMessage || !authorName || !authorEmail) {
      return error(400, 'Missing required fields: path, commitMessage, authorName, authorEmail');
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
      return error(403, 'Only repository maintainers can edit files directly. Please submit a pull request instead.');
    }

    if (action === 'delete') {
      await fileManager.deleteFile(
        npub,
        repo,
        path,
        commitMessage,
        authorName,
        authorEmail,
        branch || 'main'
      );
      return json({ success: true, message: 'File deleted and committed' });
    } else if (action === 'create' || content !== undefined) {
      if (content === undefined) {
        return error(400, 'Content is required for create/update operations');
      }
      await fileManager.writeFile(
        npub,
        repo,
        path,
        content,
        commitMessage,
        authorName,
        authorEmail,
        branch || 'main'
      );
      return json({ success: true, message: 'File saved and committed' });
    } else {
      return error(400, 'Invalid action or missing content');
    }
  } catch (err) {
    console.error('Error writing file:', err);
    return error(500, err instanceof Error ? err.message : 'Failed to write file');
  }
};
