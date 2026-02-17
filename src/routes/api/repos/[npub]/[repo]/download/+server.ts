/**
 * API endpoint for downloading repository as ZIP
 */

import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fileManager, repoManager, nostrClient } from '$lib/services/service-registry.js';
import { createRepoGetHandler } from '$lib/utils/api-handlers.js';
import type { RepoRequestContext, RequestEvent } from '$lib/utils/api-context.js';
import { spawn } from 'child_process';
import { mkdir, rm, readFile } from 'fs/promises';
import { join, resolve } from 'path';
import logger from '$lib/services/logger.js';
import { isValidBranchName, sanitizeError } from '$lib/utils/security.js';
import simpleGit from 'simple-git';
import { handleApiError, handleNotFoundError } from '$lib/utils/error-handler.js';
import { KIND } from '$lib/types/nostr.js';
import { existsSync } from 'fs';
import { repoCache, RepoCache } from '$lib/services/git/repo-cache.js';

const repoRoot = typeof process !== 'undefined' && process.env?.GIT_REPO_ROOT
  ? process.env.GIT_REPO_ROOT
  : '/repos';

export const GET: RequestHandler = createRepoGetHandler(
  async (context: RepoRequestContext, event: RequestEvent) => {
    const repoPath = join(repoRoot, context.npub, `${context.repo}.git`);
    
    // If repo doesn't exist, try to fetch it on-demand
    if (!existsSync(repoPath)) {
      try {
        // Fetch repository announcement from Nostr
        const events = await nostrClient.fetchEvents([
          {
            kinds: [KIND.REPO_ANNOUNCEMENT],
            authors: [context.repoOwnerPubkey],
            '#d': [context.repo],
            limit: 1
          }
        ]);

        if (events.length > 0) {
          // Try to fetch the repository from remote clone URLs
          const fetched = await repoManager.fetchRepoOnDemand(
            context.npub,
            context.repo,
            events[0]
          );
          
          // Always check if repo exists after fetch attempt (might have been created)
          // Also clear cache to ensure fileManager sees it
          if (existsSync(repoPath)) {
            repoCache.delete(RepoCache.repoExistsKey(context.npub, context.repo));
            // Repo exists, continue with normal flow
          } else if (!fetched) {
            // Fetch failed and repo doesn't exist
            throw handleNotFoundError(
              'Repository not found and could not be fetched from remote. The repository may not have any accessible clone URLs.',
              { operation: 'download', npub: context.npub, repo: context.repo }
            );
          } else {
            // Fetch returned true but repo doesn't exist - this shouldn't happen, but clear cache anyway
            repoCache.delete(RepoCache.repoExistsKey(context.npub, context.repo));
            // Wait a moment for filesystem to sync, then check again
            await new Promise(resolve => setTimeout(resolve, 100));
            if (!existsSync(repoPath)) {
              throw handleNotFoundError(
                'Repository fetch completed but repository is not accessible',
                { operation: 'download', npub: context.npub, repo: context.repo }
              );
            }
          }
        } else {
          throw handleNotFoundError(
            'Repository announcement not found in Nostr',
            { operation: 'download', npub: context.npub, repo: context.repo }
          );
        }
      } catch (err) {
        // Check if repo was created by another concurrent request
        if (existsSync(repoPath)) {
          // Repo exists now, clear cache and continue with normal flow
          repoCache.delete(RepoCache.repoExistsKey(context.npub, context.repo));
        } else {
          // If fetching fails, return 404
          throw handleNotFoundError(
            'Repository not found',
            { operation: 'download', npub: context.npub, repo: context.repo }
          );
        }
      }
    }

    // Double-check repo exists after on-demand fetch
    if (!existsSync(repoPath)) {
      throw handleNotFoundError(
        'Repository not found',
        { operation: 'download', npub: context.npub, repo: context.repo }
      );
    }

    let ref = event.url.searchParams.get('ref') || 'HEAD';
    const format = event.url.searchParams.get('format') || 'zip'; // zip or tar.gz

    // If ref is a branch name, validate it exists or use default branch
    if (ref !== 'HEAD' && !ref.startsWith('refs/')) {
      // Security: Validate ref to prevent command injection
      if (!isValidBranchName(ref)) {
        throw error(400, 'Invalid ref format');
      }
      
      // Validate branch exists or use default
      try {
        const branches = await fileManager.getBranches(context.npub, context.repo);
        if (!branches.includes(ref)) {
          // Branch doesn't exist, use default branch
          ref = await fileManager.getDefaultBranch(context.npub, context.repo);
        }
      } catch {
        // If we can't get branches, fall back to HEAD
        ref = 'HEAD';
      }
    }

    // Security: Validate format
    if (format !== 'zip' && format !== 'tar.gz') {
      throw error(400, 'Invalid format. Must be "zip" or "tar.gz"');
    }
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

      // Verify workDir has content before archiving
      const { readdir } = await import('fs/promises');
      const workDirContents = await readdir(workDir);
      if (workDirContents.length === 0) {
        throw new Error('Repository work directory is empty, cannot create archive');
      }

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
        // Make archive path absolute for zip command
        const absoluteArchivePath = resolve(archivePath);
        
        // Ensure the archive directory exists
        const archiveDir = join(absoluteArchivePath, '..');
        await mkdir(archiveDir, { recursive: true });
        
        await new Promise<void>((resolve, reject) => {
          const zipProcess = spawn('zip', ['-r', absoluteArchivePath, '.'], {
            cwd: workDir,
            stdio: ['ignore', 'pipe', 'pipe']
          });
          let stdout = '';
          let stderr = '';
          zipProcess.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
          zipProcess.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
          zipProcess.on('close', async (code) => {
            if (code === 0) {
              // Verify archive was created
              try {
                const fs = await import('fs/promises');
                await fs.access(absoluteArchivePath);
                resolve();
              } catch {
                reject(new Error(`zip command succeeded but archive file was not created at ${absoluteArchivePath}`));
              }
            } else {
              const errorMsg = (stderr || stdout || 'Unknown error').trim();
              reject(new Error(`zip failed with code ${code}: ${errorMsg || 'No error message'}`));
            }
          });
          zipProcess.on('error', (err) => {
            // If zip command doesn't exist, provide helpful error
            if (err.message.includes('ENOENT') || (err as any).code === 'ENOENT') {
              reject(new Error('zip command not found. Please install zip utility (e.g., apt-get install zip or brew install zip)'));
            } else {
              reject(err);
            }
          });
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
  { operation: 'download', requireRepoExists: false, requireRepoAccess: false } // Handle on-demand fetching, downloads are public
);
