/**
 * API endpoint for raw file access
 */

import type { RequestHandler } from './$types';
import { fileManager, repoManager } from '$lib/services/service-registry.js';
import { createRepoGetHandler } from '$lib/utils/api-handlers.js';
import type { RepoRequestContext, RequestEvent } from '$lib/utils/api-context.js';
import { handleValidationError } from '$lib/utils/error-handler.js';
import { spawn } from 'child_process';
import { join } from 'path';
import { promisify } from 'util';

const repoRoot = typeof process !== 'undefined' && process.env?.GIT_REPO_ROOT
  ? process.env.GIT_REPO_ROOT
  : '/repos';

// Check if a file extension is a binary image type
function isBinaryImage(ext: string): boolean {
  const binaryImageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'apng', 'avif'];
  return binaryImageExtensions.includes(ext.toLowerCase());
}

export const GET: RequestHandler = createRepoGetHandler(
  async (context: RepoRequestContext, event: RequestEvent) => {
    const filePath = context.path || event.url.searchParams.get('path');
    const ref = context.ref || event.url.searchParams.get('ref') || 'HEAD';

    if (!filePath) {
      throw handleValidationError('Missing path parameter', { operation: 'getRawFile', npub: context.npub, repo: context.repo });
    }

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
      'bmp': 'image/bmp',
      'ico': 'image/x-icon',
      'pdf': 'application/pdf',
      'txt': 'text/plain',
      'md': 'text/markdown',
      'yml': 'text/yaml',
      'yaml': 'text/yaml',
    };

    const contentType = contentTypeMap[ext || ''] || 'text/plain';

    // For binary image files, use git cat-file to get raw binary data
    if (ext && isBinaryImage(ext)) {
      const repoPath = join(repoRoot, context.npub, `${context.repo}.git`);
      
      // Get the blob hash for the file
      return new Promise<Response>((resolve, reject) => {
        // First, get the object hash using git ls-tree
        const lsTreeProcess = spawn('git', ['ls-tree', ref, filePath], {
          cwd: repoPath,
          stdio: ['ignore', 'pipe', 'pipe']
        });

        let lsTreeOutput = '';
        let lsTreeError = '';

        lsTreeProcess.stdout.on('data', (data: Buffer) => {
          lsTreeOutput += data.toString();
        });

        lsTreeProcess.stderr.on('data', (data: Buffer) => {
          lsTreeError += data.toString();
        });

        lsTreeProcess.on('close', (code) => {
          if (code !== 0) {
            reject(new Error(`Failed to get file hash: ${lsTreeError || 'Unknown error'}`));
            return;
          }

          // Parse the output: format is "mode type hash\tpath"
          const match = lsTreeOutput.match(/^\d+\s+\w+\s+([a-f0-9]{40})\s+/);
          if (!match) {
            reject(new Error('Failed to parse file hash from git ls-tree output'));
            return;
          }

          const blobHash = match[1];

          // Now get the binary content using git cat-file
          const catFileProcess = spawn('git', ['cat-file', 'blob', blobHash], {
            cwd: repoPath,
            stdio: ['ignore', 'pipe', 'pipe']
          });

          const chunks: Buffer[] = [];
          let catFileError = '';

          catFileProcess.stdout.on('data', (data: Buffer) => {
            chunks.push(data);
          });

          catFileProcess.stderr.on('data', (data: Buffer) => {
            catFileError += data.toString();
          });

          catFileProcess.on('close', (code) => {
            if (code !== 0) {
              reject(new Error(`Failed to get file content: ${catFileError || 'Unknown error'}`));
              return;
            }

            const binaryContent = Buffer.concat(chunks);
            resolve(new Response(binaryContent, {
              headers: {
                'Content-Type': contentType,
                'Content-Disposition': `inline; filename="${filePath.split('/').pop()}"`,
                'Cache-Control': 'public, max-age=3600'
              }
            }));
          });

          catFileProcess.on('error', (err) => {
            reject(new Error(`Failed to execute git cat-file: ${err.message}`));
          });
        });

        lsTreeProcess.on('error', (err) => {
          reject(new Error(`Failed to execute git ls-tree: ${err.message}`));
        });
      });
    } else {
      // For text files (including SVG), use the existing method
      const fileData = await fileManager.getFileContent(context.npub, context.repo, filePath, ref);
      
      return new Response(fileData.content, {
        headers: {
          'Content-Type': contentType,
          'Content-Disposition': `inline; filename="${filePath.split('/').pop()}"`,
          'Cache-Control': 'public, max-age=3600'
        }
      });
    }
  },
  { operation: 'getRawFile' }
);
