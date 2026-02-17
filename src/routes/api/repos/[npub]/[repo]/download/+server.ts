/**
 * API endpoint for downloading repository as ZIP
 */

import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { FileManager } from '$lib/services/git/file-manager.js';
import { MaintainerService } from '$lib/services/nostr/maintainer-service.js';
import { DEFAULT_NOSTR_RELAYS } from '$lib/config.js';
import { requireNpubHex } from '$lib/utils/npub-utils.js';
import { spawn } from 'child_process';
import { mkdir, rm, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import logger from '$lib/services/logger.js';
import { isValidBranchName, sanitizeError } from '$lib/utils/security.js';
import simpleGit from 'simple-git';
import { handleApiError, handleValidationError, handleNotFoundError, handleAuthorizationError } from '$lib/utils/error-handler.js';
const repoRoot = process.env.GIT_REPO_ROOT || '/repos';
const fileManager = new FileManager(repoRoot);
const maintainerService = new MaintainerService(DEFAULT_NOSTR_RELAYS);

export const GET: RequestHandler = async ({ params, url, request }) => {
  const { npub, repo } = params;
  const ref = url.searchParams.get('ref') || 'HEAD';
  const format = url.searchParams.get('format') || 'zip'; // zip or tar.gz
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
      repoOwnerPubkey = requireNpubHex(npub);
    } catch {
      return error(400, 'Invalid npub format');
    }

    const canView = await maintainerService.canView(userPubkey || null, repoOwnerPubkey, repo);
    if (!canView) {
      return error(403, 'This repository is private. Only owners and maintainers can view it.');
    }

    // Security: Validate ref to prevent command injection
    if (ref !== 'HEAD' && !isValidBranchName(ref)) {
      return error(400, 'Invalid ref format');
    }

    // Security: Validate format
    if (format !== 'zip' && format !== 'tar.gz') {
      return error(400, 'Invalid format. Must be "zip" or "tar.gz"');
    }

    const repoPath = join(repoRoot, npub, `${repo}.git`);
    // Security: Ensure resolved path is within repoRoot
    const resolvedRepoPath = resolve(repoPath).replace(/\\/g, '/');
    const resolvedRoot = resolve(repoRoot).replace(/\\/g, '/');
    if (!resolvedRepoPath.startsWith(resolvedRoot + '/')) {
      return error(403, 'Invalid repository path');
    }

    const tempDir = join(repoRoot, '..', 'temp-downloads');
    const workDir = join(tempDir, `${npub}-${repo}-${Date.now()}`);
    // Security: Ensure workDir is within tempDir
    const resolvedWorkDir = resolve(workDir).replace(/\\/g, '/');
    const resolvedTempDir = resolve(tempDir).replace(/\\/g, '/');
    if (!resolvedWorkDir.startsWith(resolvedTempDir + '/')) {
      return error(500, 'Invalid work directory path');
    }

    const archiveName = `${repo}-${ref}.${format === 'tar.gz' ? 'tar.gz' : 'zip'}`;
    const archivePath = join(tempDir, archiveName);
    // Security: Ensure archive path is within tempDir
    const resolvedArchivePath = resolve(archivePath).replace(/\\/g, '/');
    if (!resolvedArchivePath.startsWith(resolvedTempDir + '/')) {
      return error(500, 'Invalid archive path');
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
      logger.error({ error: sanitizedError, npub, repo, ref, format }, 'Error creating archive');
      throw archiveError;
    }
  } catch (err) {
    return handleApiError(err, { operation: 'download', npub, repo, ref, format }, 'Failed to create repository archive');
  }
};
