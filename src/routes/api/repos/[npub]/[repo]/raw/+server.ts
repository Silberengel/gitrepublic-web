/**
 * API endpoint for raw file access
 */

import type { RequestHandler } from './$types';
import { fileManager } from '$lib/services/service-registry.js';
import { createRepoGetHandler } from '$lib/utils/api-handlers.js';
import type { RepoRequestContext, RequestEvent } from '$lib/utils/api-context.js';
import { handleValidationError } from '$lib/utils/error-handler.js';

export const GET: RequestHandler = createRepoGetHandler(
  async (context: RepoRequestContext, event: RequestEvent) => {
    const filePath = context.path || event.url.searchParams.get('path');
    const ref = context.ref || 'HEAD';

    if (!filePath) {
      throw handleValidationError('Missing path parameter', { operation: 'getRawFile', npub: context.npub, repo: context.repo });
    }

    // Get file content
    const fileData = await fileManager.getFileContent(context.npub, context.repo, filePath, ref);

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
  },
  { operation: 'getRawFile' }
);
