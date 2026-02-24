/**
 * API endpoint for downloading repository as ZIP or TAR.GZ
 * Refactored for better error handling and reliability
 */

import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fileManager, nostrClient } from '$lib/services/service-registry.js';
import { createRepoGetHandler } from '$lib/utils/api-handlers.js';
import type { RepoRequestContext, RequestEvent } from '$lib/utils/api-context.js';
import { spawn } from 'child_process';
import { mkdir, rm, readFile, readdir } from 'fs/promises';
import { join, resolve } from 'path';
import logger from '$lib/services/logger.js';
import { isValidBranchName, sanitizeError } from '$lib/utils/security.js';
import simpleGit from 'simple-git';
import { handleNotFoundError } from '$lib/utils/error-handler.js';
import { existsSync } from 'fs';
import { repoCache, RepoCache } from '$lib/services/git/repo-cache.js';
import { eventCache } from '$lib/services/nostr/event-cache.js';
import { fetchRepoAnnouncementsWithCache, findRepoAnnouncement } from '$lib/utils/nostr-utils.js';

const repoRoot = typeof process !== 'undefined' && process.env?.GIT_REPO_ROOT
  ? process.env.GIT_REPO_ROOT
  : '/repos';

interface TempCloneResult {
  path: string;
  cleanup: () => Promise<void>;
}

/**
 * Attempts to create a temporary clone of a repository for download
 */
async function createTempClone(
  context: RepoRequestContext,
  repoPath: string
): Promise<TempCloneResult | null> {
  // Check if repo exists now (might have been created by concurrent request)
  if (existsSync(repoPath)) {
    return null;
  }

  try {
    // Fetch repository announcement
    const allEvents = await fetchRepoAnnouncementsWithCache(
      nostrClient,
      context.repoOwnerPubkey,
      eventCache
    );
    const announcement = findRepoAnnouncement(allEvents, context.repo);

    if (!announcement) {
      logger.debug({ npub: context.npub, repo: context.repo }, 'No announcement found for temp clone');
      return null;
    }

    logger.info({ npub: context.npub, repo: context.repo }, 'Creating temporary clone for download');

    // Setup temp clone directory
    const tempDir = resolve(join(repoRoot, '..', 'temp-clones'));
    await mkdir(tempDir, { recursive: true });
    const tempClonePath = join(tempDir, `${context.npub}-${context.repo}-${Date.now()}.git`);

    // Extract and prepare clone URLs
    const { extractCloneUrls } = await import('$lib/utils/nostr-utils.js');
    const cloneUrls = extractCloneUrls(announcement);
    const { RepoUrlParser } = await import('$lib/services/git/repo-url-parser.js');
    const urlParser = new RepoUrlParser(repoRoot, 'gitrepublic.com');
    const remoteUrls = urlParser.prepareRemoteUrls(cloneUrls);

    if (remoteUrls.length === 0) {
      logger.warn({ npub: context.npub, repo: context.repo }, 'No remote clone URLs available');
      return null;
    }

    // Setup git remote sync
    const { GitRemoteSync } = await import('$lib/services/git/git-remote-sync.js');
    const remoteSync = new GitRemoteSync(repoRoot, 'gitrepublic.com');
    const gitEnv = remoteSync.getGitEnvForUrl(remoteUrls[0]);
    const authenticatedUrl = remoteSync.injectAuthToken(remoteUrls[0]);

    // Clone the repository
    const { GIT_CLONE_TIMEOUT_MS } = await import('$lib/config.js');
    await cloneRepository(authenticatedUrl, tempClonePath, gitEnv, GIT_CLONE_TIMEOUT_MS);

    logger.info({ npub: context.npub, repo: context.repo, tempPath: tempClonePath }, 'Temporary clone created successfully');

    return {
      path: tempClonePath,
      cleanup: async () => {
        try {
          if (existsSync(tempClonePath)) {
            await rm(tempClonePath, { recursive: true, force: true });
            logger.debug({ tempPath: tempClonePath }, 'Cleaned up temporary clone');
          }
        } catch (cleanupErr) {
          logger.warn({ error: cleanupErr, tempPath: tempClonePath }, 'Failed to clean up temp clone');
        }
      }
    };
  } catch (err) {
    logger.error({ error: err, npub: context.npub, repo: context.repo }, 'Failed to create temporary clone');
    return null;
  }
}

/**
 * Clones a repository with timeout and proper error handling
 */
function cloneRepository(
  url: string,
  targetPath: string,
  env: Record<string, string>,
  timeoutMs: number
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cloneProcess = spawn('git', ['clone', '--bare', url, targetPath], {
      env: { ...process.env, ...env },
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
      reject(new Error(`Git clone operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    let stderr = '';
    cloneProcess.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    cloneProcess.on('close', (code) => {
      clearTimeout(timeoutId);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Git clone failed with code ${code}: ${stderr.trim() || 'Unknown error'}`));
      }
    });

    cloneProcess.on('error', (err) => {
      clearTimeout(timeoutId);
      reject(err);
    });
  });
}

/**
 * Validates and resolves the ref (branch, tag, or commit)
 */
async function resolveRef(
  context: RepoRequestContext,
  ref: string
): Promise<string> {
  // HEAD is always valid
  if (ref === 'HEAD' || ref.startsWith('refs/')) {
    return ref;
  }

  // Commit hash (40-character hex) is valid
  if (/^[0-9a-f]{40}$/i.test(ref)) {
    return ref;
  }

  // Security: Validate ref format
  if (!isValidBranchName(ref)) {
    throw error(400, `Invalid ref format: ${ref}`);
  }

  // Check if it's a tag
  try {
    const tags = await fileManager.getTags(context.npub, context.repo);
    if (tags && Array.isArray(tags) && tags.some(t => t.name === ref)) {
      logger.debug({ ref, npub: context.npub, repo: context.repo }, 'Resolved ref as tag');
      return ref; // Tags are valid refs
    }
  } catch (tagErr) {
    logger.warn({ error: tagErr, ref, npub: context.npub, repo: context.repo }, 'Could not fetch tags, checking branches');
    // Continue to check branches - don't fail here
  }

  // Check if it's a branch
  try {
    const branches = await fileManager.getBranches(context.npub, context.repo);
    if (branches.includes(ref)) {
      return ref;
    }
    // Branch doesn't exist, use default branch
    const defaultBranch = await fileManager.getDefaultBranch(context.npub, context.repo);
    logger.debug({ requestedRef: ref, defaultBranch }, 'Requested branch not found, using default');
    return defaultBranch;
  } catch (branchErr) {
    logger.warn({ error: branchErr, ref }, 'Could not fetch branches, falling back to HEAD');
    return 'HEAD';
  }
}

/**
 * Creates a ZIP archive
 */
function createZipArchive(workDir: string, archivePath: string): Promise<void> {
  const absoluteArchivePath = resolve(archivePath);
  const archiveDir = join(absoluteArchivePath, '..');
  
  return mkdir(archiveDir, { recursive: true }).then(() => {
    return new Promise<void>((resolve, reject) => {
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
            const { access } = await import('fs/promises');
            await access(absoluteArchivePath);
            resolve();
          } catch {
            reject(new Error(`Archive file was not created at ${absoluteArchivePath}`));
          }
        } else {
          const errorMsg = (stderr || stdout || 'Unknown error').trim();
          reject(new Error(`zip failed with code ${code}: ${errorMsg}`));
        }
      });

      zipProcess.on('error', (err) => {
        if (err.message.includes('ENOENT') || (err as any).code === 'ENOENT') {
          reject(new Error('zip command not found. Please install zip utility (e.g., apt-get install zip)'));
        } else {
          reject(err);
        }
      });
    });
  });
}

/**
 * Creates a TAR.GZ archive
 */
function createTarGzArchive(workDir: string, archivePath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const tarProcess = spawn('tar', ['-czf', archivePath, '-C', workDir, '.'], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stderr = '';
    tarProcess.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    tarProcess.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`tar failed with code ${code}: ${stderr.trim() || 'Unknown error'}`));
      }
    });

    tarProcess.on('error', reject);
  });
}

/**
 * Main download handler
 */
export const GET: RequestHandler = createRepoGetHandler(
  async (context: RepoRequestContext, event: RequestEvent) => {
    const repoPath = join(repoRoot, context.npub, `${context.repo}.git`);
    let tempClone: TempCloneResult | null = null;
    let workDir: string | null = null;
    let archivePath: string | null = null;

    try {
      // Determine source repository path
      let sourceRepoPath = repoPath;
      
      if (!existsSync(repoPath)) {
        // Try to create temporary clone
        tempClone = await createTempClone(context, repoPath);
        
        if (tempClone) {
          sourceRepoPath = tempClone.path;
        } else if (!existsSync(repoPath)) {
          // Check again if repo was created by concurrent request
          if (existsSync(repoPath)) {
            sourceRepoPath = repoPath;
            repoCache.delete(RepoCache.repoExistsKey(context.npub, context.repo));
          } else {
            throw handleNotFoundError(
              'Repository not found',
              { operation: 'download', npub: context.npub, repo: context.repo }
            );
          }
        }
      }

      // Verify source repo exists
      if (!existsSync(sourceRepoPath)) {
        throw handleNotFoundError(
          'Repository not found',
          { operation: 'download', npub: context.npub, repo: context.repo }
        );
      }

      // Parse and validate request parameters
      let ref = event.url.searchParams.get('ref') || 'HEAD';
      const format = event.url.searchParams.get('format') || 'zip';

      if (format !== 'zip' && format !== 'tar.gz') {
        throw error(400, 'Invalid format. Must be "zip" or "tar.gz"');
      }

      // Resolve ref (branch, tag, or commit)
      ref = await resolveRef(context, ref);

      // Security: Validate paths
      const resolvedRepoPath = resolve(repoPath).replace(/\\/g, '/');
      const resolvedRoot = resolve(repoRoot).replace(/\\/g, '/');
      if (!resolvedRepoPath.startsWith(resolvedRoot + '/')) {
        throw error(403, 'Invalid repository path');
      }

      // Setup temporary directories
      const tempDir = resolve(join(repoRoot, '..', 'temp-downloads'));
      await mkdir(tempDir, { recursive: true });
      
      workDir = join(tempDir, `${context.npub}-${context.repo}-${Date.now()}`);
      await mkdir(workDir, { recursive: true });

      // Security: Validate workDir path
      const resolvedWorkDir = resolve(workDir).replace(/\\/g, '/');
      const resolvedTempDir = resolve(tempDir).replace(/\\/g, '/');
      if (!resolvedWorkDir.startsWith(resolvedTempDir + '/')) {
        throw error(500, 'Invalid work directory path');
      }

      const archiveName = `${context.repo}-${ref.replace(/[^a-zA-Z0-9._-]/g, '_')}.${format === 'tar.gz' ? 'tar.gz' : 'zip'}`;
      archivePath = join(tempDir, archiveName);

      // Security: Validate archive path
      const resolvedArchivePath = resolve(archivePath).replace(/\\/g, '/');
      if (!resolvedArchivePath.startsWith(resolvedTempDir + '/')) {
        throw error(500, 'Invalid archive path');
      }

      // Clone repository to work directory
      logger.debug({ sourceRepoPath, workDir, ref }, 'Cloning repository for archive');
      const git = simpleGit();
      await git.clone(sourceRepoPath, workDir);

      // Checkout specific ref
      if (ref !== 'HEAD') {
        const workGit = simpleGit(workDir);
        let checkoutSuccess = false;
        
        // Try direct checkout first
        try {
          await workGit.checkout(ref);
          checkoutSuccess = true;
          logger.debug({ ref }, 'Successfully checked out ref directly');
        } catch (checkoutErr) {
          logger.debug({ error: checkoutErr, ref }, 'Direct checkout failed, trying as tag');
        }
        
        // If direct checkout failed, try as tag
        if (!checkoutSuccess) {
          try {
            await workGit.checkout(`refs/tags/${ref}`);
            checkoutSuccess = true;
            logger.debug({ ref }, 'Successfully checked out ref as tag');
          } catch (tagErr) {
            // Try as branch
            try {
              await workGit.checkout(`refs/heads/${ref}`);
              checkoutSuccess = true;
              logger.debug({ ref }, 'Successfully checked out ref as branch');
            } catch (branchErr) {
              // Last resort: try to fetch the ref from remote
              try {
                await workGit.fetch(sourceRepoPath, ref);
                await workGit.checkout(ref);
                checkoutSuccess = true;
                logger.debug({ ref }, 'Successfully checked out ref after fetch');
              } catch (fetchErr) {
                const errorMsg = `Failed to checkout ref "${ref}". Tried as direct ref, tag, and branch. Last error: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`;
                logger.error({ error: fetchErr, ref, npub: context.npub, repo: context.repo }, errorMsg);
                throw new Error(errorMsg);
              }
            }
          }
        }
        
        if (!checkoutSuccess) {
          throw new Error(`Failed to checkout ref "${ref}" after all attempts`);
        }
      }

      // Remove .git directory
      await rm(join(workDir, '.git'), { recursive: true, force: true });

      // Verify work directory has content
      const workDirContents = await readdir(workDir);
      if (workDirContents.length === 0) {
        throw new Error('Repository work directory is empty, cannot create archive');
      }

      // Create archive
      logger.debug({ format, archivePath }, 'Creating archive');
      if (format === 'tar.gz') {
        await createTarGzArchive(workDir, archivePath);
      } else {
        await createZipArchive(workDir, archivePath);
      }

      // Read archive file
      const archiveBuffer = await readFile(archivePath);

      // Clean up temporary files
      if (workDir) {
        await rm(workDir, { recursive: true, force: true }).catch(() => {});
      }
      if (archivePath) {
        await rm(archivePath, { force: true }).catch(() => {});
      }
      if (tempClone) {
        await tempClone.cleanup();
      }

      // Return archive
      logger.info({ npub: context.npub, repo: context.repo, ref, format, size: archiveBuffer.length }, 'Download completed successfully');
      
      return new Response(archiveBuffer, {
        headers: {
          'Content-Type': format === 'tar.gz' ? 'application/gzip' : 'application/zip',
          'Content-Disposition': `attachment; filename="${archiveName}"`,
          'Content-Length': archiveBuffer.length.toString(),
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0'
        }
      });
    } catch (err) {
      // Clean up on error
      const cleanupPromises: Promise<void>[] = [];
      
      if (workDir) {
        cleanupPromises.push(rm(workDir, { recursive: true, force: true }).catch(() => {}));
      }
      if (archivePath) {
        cleanupPromises.push(rm(archivePath, { force: true }).catch(() => {}));
      }
      if (tempClone) {
        cleanupPromises.push(tempClone.cleanup());
      }
      
      await Promise.all(cleanupPromises);

      // Log error
      const sanitizedError = sanitizeError(err);
      logger.error(
        { error: sanitizedError, npub: context.npub, repo: context.repo, ref: event.url.searchParams.get('ref') },
        'Error creating archive'
      );

      // Re-throw if it's already a Response (from error handlers)
      if (err instanceof Response) {
        throw err;
      }

      // Re-throw if it's a SvelteKit error
      if (err && typeof err === 'object' && 'status' in err && 'body' in err) {
        throw err;
      }

      // Wrap other errors
      throw error(500, `Failed to create archive: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
  { operation: 'download', requireRepoExists: false, requireRepoAccess: true }
);
