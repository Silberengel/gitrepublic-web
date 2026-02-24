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
import { eventCache } from '$lib/services/nostr/event-cache.js';
import { fetchRepoAnnouncementsWithCache, findRepoAnnouncement } from '$lib/utils/nostr-utils.js';

const repoRoot = typeof process !== 'undefined' && process.env?.GIT_REPO_ROOT
  ? process.env.GIT_REPO_ROOT
  : '/repos';

export const GET: RequestHandler = createRepoGetHandler(
  async (context: RepoRequestContext, event: RequestEvent) => {
    const repoPath = join(repoRoot, context.npub, `${context.repo}.git`);
    let useTempClone = false;
    let tempClonePath: string | null = null;
    
    // If repo doesn't exist, try to do a temporary clone
    if (!existsSync(repoPath)) {
      try {
        // Fetch repository announcement (case-insensitive) with caching
        const allEvents = await fetchRepoAnnouncementsWithCache(nostrClient, context.repoOwnerPubkey, eventCache);
        const announcement = findRepoAnnouncement(allEvents, context.repo);

        if (announcement) {
          // Try to do a temporary clone for download
          logger.info({ npub: context.npub, repo: context.repo }, 'Repository not cloned locally, attempting temporary clone for download');
          
          const tempDir = resolve(join(repoRoot, '..', 'temp-clones'));
          await mkdir(tempDir, { recursive: true });
          tempClonePath = join(tempDir, `${context.npub}-${context.repo}-${Date.now()}.git`);
          
          // Extract clone URLs and prepare remote URLs
          const { extractCloneUrls } = await import('$lib/utils/nostr-utils.js');
          const cloneUrls = extractCloneUrls(announcement);
          const { RepoUrlParser } = await import('$lib/services/git/repo-url-parser.js');
          const urlParser = new RepoUrlParser(repoRoot, 'gitrepublic.com');
          const remoteUrls = urlParser.prepareRemoteUrls(cloneUrls);
          
          if (remoteUrls.length > 0) {
            const { GitRemoteSync } = await import('$lib/services/git/git-remote-sync.js');
            const remoteSync = new GitRemoteSync(repoRoot, 'gitrepublic.com');
            const gitEnv = remoteSync.getGitEnvForUrl(remoteUrls[0]);
            const authenticatedUrl = remoteSync.injectAuthToken(remoteUrls[0]);
            
            const { GIT_CLONE_TIMEOUT_MS } = await import('$lib/config.js');
            
            await new Promise<void>((resolve, reject) => {
              const cloneProcess = spawn('git', ['clone', '--bare', authenticatedUrl, tempClonePath!], {
                env: gitEnv,
                stdio: ['ignore', 'pipe', 'pipe']
              });

              const timeoutId = setTimeout(() => {
                cloneProcess.kill('SIGTERM');
                const forceKillTimeout = setTimeout(() => {
                  if (!cloneProcess.killed) {
                    cloneProcess.kill('SIGKILL');
                  }
                }, 5000);
                cloneProcess.on('close', () => {
                  clearTimeout(forceKillTimeout);
                });
                reject(new Error(`Git clone operation timed out after ${GIT_CLONE_TIMEOUT_MS}ms`));
              }, GIT_CLONE_TIMEOUT_MS);

              let stderr = '';
              cloneProcess.stderr.on('data', (chunk: Buffer) => {
                stderr += chunk.toString();
              });

              cloneProcess.on('close', (code) => {
                clearTimeout(timeoutId);
                if (code === 0) {
                  logger.info({ npub: context.npub, repo: context.repo, tempPath: tempClonePath }, 'Successfully created temporary clone');
                  useTempClone = true;
                  resolve();
                } else {
                  reject(new Error(`Git clone failed with code ${code}: ${stderr}`));
                }
              });
              cloneProcess.on('error', reject);
            });
          } else {
            throw new Error('No remote clone URLs available');
          }
        } else {
          throw handleNotFoundError(
            'Repository announcement not found in Nostr',
            { operation: 'download', npub: context.npub, repo: context.repo }
          );
        }
      } catch (err) {
        // Clean up temp clone if it was created
        if (tempClonePath && existsSync(tempClonePath)) {
          await rm(tempClonePath, { recursive: true, force: true }).catch(() => {});
        }
        
        // Check if repo was created by another concurrent request
        if (existsSync(repoPath)) {
          // Repo exists now, clear cache and continue with normal flow
          repoCache.delete(RepoCache.repoExistsKey(context.npub, context.repo));
        } else {
          // If fetching fails, return 404
          throw handleNotFoundError(
            err instanceof Error ? err.message : 'Repository not found',
            { operation: 'download', npub: context.npub, repo: context.repo }
          );
        }
      }
    }

    // Use temp clone path if we created one, otherwise use regular repo path
    const sourceRepoPath = useTempClone && tempClonePath ? tempClonePath : repoPath;
    
    // Double-check source repo exists
    if (!existsSync(sourceRepoPath)) {
      throw handleNotFoundError(
        'Repository not found',
        { operation: 'download', npub: context.npub, repo: context.repo }
      );
    }

    let ref = event.url.searchParams.get('ref') || 'HEAD';
    const format = event.url.searchParams.get('format') || 'zip'; // zip or tar.gz

    // If ref is a branch name, validate it exists or use default branch
    if (ref !== 'HEAD' && !ref.startsWith('refs/')) {
      // Check if ref is a commit hash (40-character hex string)
      const isCommitHash = /^[0-9a-f]{40}$/i.test(ref);
      
      if (isCommitHash) {
        // Commit hash is valid, use it directly
        // Git will validate the commit exists when we try to use it
      } else {
        // Security: Validate ref to prevent command injection
        if (!isValidBranchName(ref)) {
          throw error(400, 'Invalid ref format');
        }
        
        // Check if it's a tag first (tags are also valid refs)
        let isTag = false;
        try {
          const tags = await fileManager.getTags(context.npub, context.repo);
          isTag = tags.some(t => t.name === ref);
        } catch {
          // If we can't get tags, continue with branch check
        }
        
        if (!isTag) {
          // Not a tag, validate branch exists or use default
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
        // If it's a tag, use it directly (git accepts tag names as refs)
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
      await git.clone(sourceRepoPath, workDir);

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
      // Clean up temp clone if we created one
      if (useTempClone && tempClonePath && existsSync(tempClonePath)) {
        await rm(tempClonePath, { recursive: true, force: true }).catch(() => {});
      }

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
      // Clean up temp clone if we created one
      if (useTempClone && tempClonePath && existsSync(tempClonePath)) {
        await rm(tempClonePath, { recursive: true, force: true }).catch(() => {});
      }
      const sanitizedError = sanitizeError(archiveError);
      logger.error({ error: sanitizedError, npub: context.npub, repo: context.repo, ref, format }, 'Error creating archive');
      throw archiveError;
    }
  },
  { operation: 'download', requireRepoExists: false, requireRepoAccess: true } // Handle on-demand fetching, but check access for private repos
);
