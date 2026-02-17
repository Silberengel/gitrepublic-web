/**
 * API endpoint for downloading repository as ZIP
 */

import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fileManager } from '$lib/services/service-registry.js';
import { createRepoGetHandler } from '$lib/utils/api-handlers.js';
import type { RepoRequestContext, RequestEvent } from '$lib/utils/api-context.js';
import { spawn } from 'child_process';
import { mkdir, rm, readFile } from 'fs/promises';
import { join, resolve } from 'path';
import logger from '$lib/services/logger.js';
import { isValidBranchName, sanitizeError } from '$lib/utils/security.js';
import simpleGit from 'simple-git';
import { handleApiError } from '$lib/utils/error-handler.js';

const repoRoot = typeof process !== 'undefined' && process.env?.GIT_REPO_ROOT
  ? process.env.GIT_REPO_ROOT
  : '/repos';

export const GET: RequestHandler = createRepoGetHandler(
  async (context: RepoRequestContext, event: RequestEvent) => {
    const ref = event.url.searchParams.get('ref') || 'HEAD';
    const format = event.url.searchParams.get('format') || 'zip'; // zip or tar.gz

    // Security: Validate ref to prevent command injection
    if (ref !== 'HEAD' && !isValidBranchName(ref)) {
      throw error(400, 'Invalid ref format');
    }

    // Security: Validate format
    if (format !== 'zip' && format !== 'tar.gz') {
      throw error(400, 'Invalid format. Must be "zip" or "tar.gz"');
    }

    const repoPath = join(repoRoot, context.npub, `${context.repo}.git`);
    // Security: Ensure resolved path is within repoRoot
    const resolvedRepoPath = resolve(repoPath).replace(/\\/g, '/');
    const resolvedRoot = resolve(repoRoot).replace(/\\/g, '/');
    if (!resolvedRepoPath.startsWith(resolvedRoot + '/')) {
      throw error(403, 'Invalid repository path');
    }

    const tempDir = join(repoRoot, '..', 'temp-downloads');
    const workDir = join(tempDir, `${context.npub}-${context.repo}-${Date.now()}`);
    // Security: Ensure workDir is within tempDir
    const resolvedWorkDir = resolve(workDir).replace(/\\/g, '/');
    const resolvedTempDir = resolve(tempDir).replace(/\\/g, '/');
    if (!resolvedWorkDir.startsWith(resolvedTempDir + '/')) {
      throw error(500, 'Invalid work directory path');
    }

    const archiveName = `${context.repo}-${ref}.${format === 'tar.gz' ? 'tar.gz' : 'zip'}`;
    const archivePath = join(tempDir, archiveName);
    // Security: Ensure archive path is within tempDir
    const resolvedArchivePath = resolve(archivePath).replace(/\\/g, '/');
    if (!resolvedArchivePath.startsWith(resolvedTempDir + '/')) {
      throw error(500, 'Invalid archive path');
    }

    try {
      // Create temp directory using fs/promises (safer than shell commands)
      await mkdir(tempDir, { recursive: true });
      await mkdir(workDir, { recursive: true });

      // Clone repository using simple-git (safer than shell commands)
      const git = simpleGit();
      await git.clone(repoPath, workDir);

      // Checkout specific ref if not HEAD
      if (ref !== 'HEAD') {
        const workGit = simpleGit(workDir);
        await workGit.checkout(ref);
      }

      // Remove .git directory using fs/promises
      await rm(join(workDir, '.git'), { recursive: true, force: true });

      // Create archive using spawn (safer than exec)
      if (format === 'tar.gz') {
        await new Promise<void>((resolve, reject) => {
          const tarProcess = spawn('tar', ['-czf', archivePath, '-C', workDir, '.'], {
            stdio: ['ignore', 'pipe', 'pipe']
          });
          let stderr = '';
          tarProcess.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
          tarProcess.on('close', (code) => {
            if (code === 0) {
              resolve();
            } else {
              reject(new Error(`tar failed: ${stderr}`));
            }
          });
          tarProcess.on('error', reject);
        });
      } else {
        // Use zip command (requires zip utility) - using spawn for safety
        await new Promise<void>((resolve, reject) => {
          const zipProcess = spawn('zip', ['-r', archivePath, '.'], {
            cwd: workDir,
            stdio: ['ignore', 'pipe', 'pipe']
          });
          let stderr = '';
          zipProcess.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
          zipProcess.on('close', (code) => {
            if (code === 0) {
              resolve();
            } else {
              reject(new Error(`zip failed: ${stderr}`));
            }
          });
          zipProcess.on('error', reject);
        });
      }

      // Read archive file using fs/promises
      const archiveBuffer = await readFile(archivePath);

      // Clean up using fs/promises
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
      await rm(archivePath, { force: true }).catch(() => {});

      // Return archive
      return new Response(archiveBuffer, {
        headers: {
          'Content-Type': format === 'tar.gz' ? 'application/gzip' : 'application/zip',
          'Content-Disposition': `attachment; filename="${archiveName}"`,
          'Content-Length': archiveBuffer.length.toString()
        }
      });
    } catch (archiveError) {
      // Clean up on error using fs/promises
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
      await rm(archivePath, { force: true }).catch(() => {});
      const sanitizedError = sanitizeError(archiveError);
      logger.error({ error: sanitizedError, npub: context.npub, repo: context.repo, ref, format }, 'Error creating archive');
      throw archiveError;
    }
  },
  { operation: 'download' }
);
