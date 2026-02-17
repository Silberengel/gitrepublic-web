/**
 * API endpoint for raw file access
 */

import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { FileManager } from '$lib/services/git/file-manager.js';
import { MaintainerService } from '$lib/services/nostr/maintainer-service.js';
import { DEFAULT_NOSTR_RELAYS } from '$lib/config.js';
import { nip19 } from 'nostr-tools';
import { requireNpubHex } from '$lib/utils/npub-utils.js';
import { handleApiError, handleValidationError, handleNotFoundError, handleAuthorizationError } from '$lib/utils/error-handler.js';

const repoRoot = process.env.GIT_REPO_ROOT || '/repos';
const fileManager = new FileManager(repoRoot);
const maintainerService = new MaintainerService(DEFAULT_NOSTR_RELAYS);

export const GET: RequestHandler = async ({ params, url, request }) => {
  const { npub, repo } = params;
  const filePath = url.searchParams.get('path');
  const ref = url.searchParams.get('ref') || 'HEAD';
  const userPubkey = url.searchParams.get('userPubkey') || request.headers.get('x-user-pubkey');

  if (!npub || !repo || !filePath) {
    return handleValidationError('Missing npub, repo, or path parameter', { operation: 'getRawFile' });
  }

  try {
    if (!fileManager.repoExists(npub, repo)) {
      return handleNotFoundError('Repository not found', { operation: 'getRawFile', npub, repo });
    }

    // Check repository privacy
    let repoOwnerPubkey: string;
    try {
      repoOwnerPubkey = requireNpubHex(npub);
    } catch {
      return handleValidationError('Invalid npub format', { operation: 'getRawFile', npub });
    }

    const canView = await maintainerService.canView(userPubkey || null, repoOwnerPubkey, repo);
    if (!canView) {
      return handleAuthorizationError('This repository is private. Only owners and maintainers can view it.', { operation: 'getRawFile', npub, repo });
    }

    // Get file content
    const fileData = await fileManager.getFileContent(npub, repo, filePath, ref);

    // Determine content type based on file extension
    const ext = filePath.split('.').pop()?.toLowerCase();
    const contentTypeMap: Record<string, string> = {
      'js': 'application/javascript',
      'ts': 'application/typescript',
      'json': 'application/json',
      'css': 'text/css',
      'html': 'text/html',
      'xml': 'application/xml',
      'svg': 'image/svg+xml',
      'png': 'image/png',
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'gif': 'image/gif',
      'webp': 'image/webp',
      'pdf': 'application/pdf',
      'txt': 'text/plain',
      'md': 'text/markdown',
      'yml': 'text/yaml',
      'yaml': 'text/yaml',
    };

    const contentType = contentTypeMap[ext || ''] || 'text/plain';

    // Return raw file content
    return new Response(fileData.content, {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `inline; filename="${filePath.split('/').pop()}"`,
        'Cache-Control': 'public, max-age=3600'
      }
    });
  } catch (err) {
    return handleApiError(err, { operation: 'getRawFile', npub, repo, filePath }, 'Failed to get raw file');
  }
};
