/**
 * API endpoint for repository branches
 * Handles GET (list), POST (create), and DELETE operations
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fileManager, repoManager, nostrClient, maintainerService } from '$lib/services/service-registry.js';
import { createRepoGetHandler, createRepoPostHandler } from '$lib/utils/api-handlers.js';
import type { RepoRequestContext, RequestEvent } from '$lib/utils/api-context.js';
import { handleValidationError, handleApiError, handleNotFoundError, handleAuthError, handleAuthorizationError } from '$lib/utils/error-handler.js';
import { join, dirname, resolve } from 'path';
import { existsSync, accessSync, constants } from 'fs';
import { repoCache, RepoCache } from '$lib/services/git/repo-cache.js';
import { DEFAULT_NOSTR_RELAYS, DEFAULT_NOSTR_SEARCH_RELAYS } from '$lib/config.js';
import { NostrClient } from '$lib/services/nostr/nostr-client.js';
import { eventCache } from '$lib/services/nostr/event-cache.js';
import { fetchRepoAnnouncementsWithCache, findRepoAnnouncement } from '$lib/utils/nostr-utils.js';
import { isGraspUrl } from '$lib/services/git/api-repo-fetcher.js';
import logger from '$lib/services/logger.js';
import simpleGit from 'simple-git';

// Resolve GIT_REPO_ROOT to absolute path
const repoRootEnv = typeof process !== 'undefined' && process.env?.GIT_REPO_ROOT
  ? process.env.GIT_REPO_ROOT
  : '/repos';
const repoRoot = resolve(repoRootEnv);

/**
 * Check if a directory exists and is writable
 */
function checkDirectoryWritable(dirPath: string, description: string): void {
  if (!existsSync(dirPath)) {
    const isContainer = existsSync('/.dockerenv') || process.env.DOCKER_CONTAINER === 'true';
    const errorMsg = isContainer
      ? `${description} does not exist at ${dirPath}. In Docker, ensure the volume is mounted correctly.`
      : `${description} does not exist at ${dirPath}`;
    throw new Error(errorMsg);
  }
  
  try {
    accessSync(dirPath, constants.W_OK);
  } catch (accessErr) {
    const isContainer = existsSync('/.dockerenv') || process.env.DOCKER_CONTAINER === 'true';
    const errorMsg = isContainer
      ? `${description} at ${dirPath} is not writable. Check volume mount permissions.`
      : `${description} at ${dirPath} is not writable`;
    throw new Error(errorMsg);
  }
}

/**
 * GET: List branches in a repository
 */
export const GET: RequestHandler = createRepoGetHandler(
  async (context: RepoRequestContext, event: RequestEvent) => {
    const repoPath = join(repoRoot, context.npub, `${context.repo}.git`);
    const skipApiFallback = event.url.searchParams.get('skipApiFallback') === 'true';
    
    // If repo doesn't exist, try API fallback (unless skipApiFallback is true)
    if (!existsSync(repoPath)) {
      if (skipApiFallback) {
        throw handleNotFoundError(
          'Repository is not cloned locally',
          { operation: 'getBranches', npub: context.npub, repo: context.repo }
        );
      }
      
      try {
        // Fetch repository announcement
        let allEvents = await fetchRepoAnnouncementsWithCache(nostrClient, context.repoOwnerPubkey, eventCache);
        let announcement = findRepoAnnouncement(allEvents, context.repo);
        
        // Try all relays if not found
        if (!announcement) {
          const allRelays = [...new Set([...DEFAULT_NOSTR_RELAYS, ...DEFAULT_NOSTR_SEARCH_RELAYS])];
          if (allRelays.length > DEFAULT_NOSTR_RELAYS.length) {
            const allRelaysClient = new NostrClient(allRelays);
            allEvents = await fetchRepoAnnouncementsWithCache(allRelaysClient, context.repoOwnerPubkey, eventCache);
            announcement = findRepoAnnouncement(allEvents, context.repo);
          }
        }
        
        if (announcement) {
          // Try API-based fetching
          const { tryApiFetch } = await import('$lib/utils/api-repo-helper.js');
          const { extractCloneUrls } = await import('$lib/utils/nostr-utils.js');
          const cloneUrls = extractCloneUrls(announcement);
          
          logger.debug({ npub: context.npub, repo: context.repo, cloneUrlCount: cloneUrls.length }, 'Attempting API fallback for branches');
          
          const apiData = await tryApiFetch(announcement, context.npub, context.repo);
          
          if (apiData && apiData.branches && apiData.branches.length > 0) {
            logger.debug({ npub: context.npub, repo: context.repo, branchCount: apiData.branches.length }, 'Successfully fetched branches via API fallback');
            // Sort branches: default branch first
            const sortedBranches = [...apiData.branches];
            if (apiData.defaultBranch) {
              sortedBranches.sort((a: any, b: any) => {
                const aName = typeof a === 'string' ? a : a.name;
                const bName = typeof b === 'string' ? b : b.name;
                if (aName === apiData.defaultBranch) return -1;
                if (bName === apiData.defaultBranch) return 1;
                return aName.localeCompare(bName);
              });
            }
            return json(sortedBranches);
          }
          
          // API fetch failed
          const hasCloneUrls = cloneUrls.length > 0;
          const cloneUrlTypes = cloneUrls.map(url => {
            if (url.includes('github.com')) return 'GitHub';
            if (url.includes('gitlab.com') || url.includes('gitlab')) return 'GitLab';
            if (url.includes('gitea')) return 'Gitea';
            if (isGraspUrl(url)) return 'GRASP';
            return 'Unknown';
          });
          
          throw handleNotFoundError(
            hasCloneUrls
              ? `Repository is not cloned locally and could not be fetched via API from external clone URLs (${cloneUrlTypes.join(', ')}).`
              : 'Repository is not cloned locally and has no external clone URLs for API fallback.',
            { operation: 'getBranches', npub: context.npub, repo: context.repo }
          );
        } else {
          throw handleNotFoundError(
            'Repository announcement not found in Nostr.',
            { operation: 'getBranches', npub: context.npub, repo: context.repo }
          );
        }
      } catch (err) {
        // Check if repo was created by another concurrent request
        if (existsSync(repoPath)) {
          repoCache.delete(RepoCache.repoExistsKey(context.npub, context.repo));
        } else {
          logger.error({ error: err, npub: context.npub, repo: context.repo }, '[Branches] Error fetching repository');
          const errorMessage = err instanceof Error ? err.message : 'Repository not found';
          throw handleNotFoundError(
            errorMessage,
            { operation: 'getBranches', npub: context.npub, repo: context.repo }
          );
        }
      }
    }

    // Repo exists, get branches
    try {
      const branches = await fileManager.getBranches(context.npub, context.repo);
      
      // If empty repo, try API fallback
      if (branches.length === 0) {
        logger.debug({ npub: context.npub, repo: context.repo }, 'Repo exists but is empty, attempting API fallback');
        
        try {
          let allEvents = await fetchRepoAnnouncementsWithCache(nostrClient, context.repoOwnerPubkey, eventCache);
          let announcement = findRepoAnnouncement(allEvents, context.repo);
          
          if (!announcement) {
            const allRelays = [...new Set([...DEFAULT_NOSTR_RELAYS, ...DEFAULT_NOSTR_SEARCH_RELAYS])];
            if (allRelays.length > DEFAULT_NOSTR_RELAYS.length) {
              const allRelaysClient = new NostrClient(allRelays);
              allEvents = await fetchRepoAnnouncementsWithCache(allRelaysClient, context.repoOwnerPubkey, eventCache);
              announcement = findRepoAnnouncement(allEvents, context.repo);
            }
          }
          
          if (announcement) {
            const { tryApiFetch } = await import('$lib/utils/api-repo-helper.js');
            const apiData = await tryApiFetch(announcement, context.npub, context.repo);
            
            if (apiData && apiData.branches && apiData.branches.length > 0) {
              logger.info({ npub: context.npub, repo: context.repo, branchCount: apiData.branches.length }, 'Successfully fetched branches via API fallback for empty repo');
              const sortedBranches = [...apiData.branches];
              if (apiData.defaultBranch) {
                sortedBranches.sort((a: any, b: any) => {
                  const aName = typeof a === 'string' ? a : a.name;
                  const bName = typeof b === 'string' ? b : b.name;
                  if (aName === apiData.defaultBranch) return -1;
                  if (bName === apiData.defaultBranch) return 1;
                  return aName.localeCompare(bName);
                });
              }
              return json(sortedBranches);
            }
          }
        } catch (apiErr) {
          logger.debug({ error: apiErr, npub: context.npub, repo: context.repo }, 'API fallback failed for empty repo');
        }
      }
      
      // Sort branches: default branch first
      let sortedBranches = [...branches];
      try {
        const defaultBranch = await fileManager.getDefaultBranch(context.npub, context.repo);
        if (defaultBranch) {
          sortedBranches.sort((a: any, b: any) => {
            const aName = typeof a === 'string' ? a : a.name;
            const bName = typeof b === 'string' ? b : b.name;
            if (aName === defaultBranch) return -1;
            if (bName === defaultBranch) return 1;
            return aName.localeCompare(bName);
          });
        } else {
          sortedBranches.sort((a: any, b: any) => {
            const aName = typeof a === 'string' ? a : a.name;
            const bName = typeof b === 'string' ? b : b.name;
            return aName.localeCompare(bName);
          });
        }
      } catch {
        sortedBranches.sort((a: any, b: any) => {
          const aName = typeof a === 'string' ? a : a.name;
          const bName = typeof b === 'string' ? b : b.name;
          return aName.localeCompare(bName);
        });
      }
      
      return json(sortedBranches);
    } catch (err) {
      logger.error({ error: err, npub: context.npub, repo: context.repo }, '[Branches] Error getting branches');
      if (err instanceof Error && err.message.includes('not found')) {
        throw handleNotFoundError(
          err.message,
          { operation: 'getBranches', npub: context.npub, repo: context.repo }
        );
      }
      throw handleApiError(
        err,
        { operation: 'getBranches', npub: context.npub, repo: context.repo },
        'Failed to get branches'
      );
    }
  },
  { operation: 'getBranches', requireRepoExists: false, requireRepoAccess: true }
);

/**
 * POST: Create a new branch
 */
export const POST: RequestHandler = createRepoPostHandler(
  async (context: RepoRequestContext, event: RequestEvent) => {
    logger.info({ 
      npub: context.npub, 
      repo: context.repo,
      userPubkey: context.userPubkeyHex ? context.userPubkeyHex.substring(0, 16) + '...' : null
    }, '[Branches POST] ========== START ==========');
    
    const body = await event.request.json();
    logger.info({ body, npub: context.npub, repo: context.repo }, '[Branches POST] Request body parsed');
    
    const { branchName, fromBranch } = body;
    logger.info({ branchName, fromBranch, npub: context.npub, repo: context.repo }, '[Branches POST] Extracted parameters');

    if (!branchName) {
      logger.error({ npub: context.npub, repo: context.repo }, '[Branches POST] Missing branchName parameter');
      throw handleValidationError('Missing branchName parameter', { operation: 'createBranch', npub: context.npub, repo: context.repo });
    }

    const repoPath = join(repoRoot, context.npub, `${context.repo}.git`);
    logger.info({ repoPath, npub: context.npub, repo: context.repo }, '[Branches POST] Repository path resolved');
    
    const repoExists = existsSync(repoPath);
    logger.info({ repoExists, repoPath, npub: context.npub, repo: context.repo }, '[Branches POST] Repository existence checked');
    
    // Authorization checks
    if (repoExists && context.userPubkeyHex) {
      const isMaintainer = await maintainerService.isMaintainer(
        context.userPubkeyHex,
        context.repoOwnerPubkey,
        context.repo
      );
      if (!isMaintainer) {
        throw handleAuthorizationError(
          'Only repository maintainers can create branches.',
          { operation: 'createBranch', npub: context.npub, repo: context.repo }
        );
      }
    } else if (repoExists && !context.userPubkeyHex) {
      throw handleAuthError(
        'Authentication required to create branches in existing repositories.',
        { operation: 'createBranch', npub: context.npub, repo: context.repo }
      );
    } else if (!repoExists && context.userPubkeyHex) {
      // New repo - verify user is the owner
      const { requireNpubHex } = await import('$lib/utils/npub-utils.js');
      const ownerPubkey = requireNpubHex(context.npub);
      if (context.userPubkeyHex.toLowerCase() !== ownerPubkey.toLowerCase()) {
        throw handleAuthorizationError(
          'Only the repository owner can create the first branch in a new repository.',
          { operation: 'createBranch', npub: context.npub, repo: context.repo }
        );
      }
    } else if (!repoExists && !context.userPubkeyHex) {
      throw handleAuthError(
        'Authentication required to create branches.',
        { operation: 'createBranch', npub: context.npub, repo: context.repo }
      );
    }

    // Create repo if it doesn't exist
    if (!repoExists) {
      logger.info({ npub: context.npub, repo: context.repo }, 'Creating new empty repository for branch creation');
      const { mkdir } = await import('fs/promises');
      
      // Check/create repoRoot
      if (!existsSync(repoRoot)) {
        try {
          await mkdir(repoRoot, { recursive: true });
          logger.debug({ repoRoot }, 'Created repoRoot directory');
        } catch (rootErr) {
          logger.error({ error: rootErr, repoRoot }, 'Failed to create repoRoot directory');
          const parentRoot = dirname(repoRoot);
          if (existsSync(parentRoot)) {
            try {
              checkDirectoryWritable(parentRoot, 'Parent directory of GIT_REPO_ROOT');
            } catch (checkErr) {
              throw handleApiError(
                checkErr,
                { operation: 'createBranch', npub: context.npub, repo: context.repo },
                checkErr instanceof Error ? checkErr.message : String(checkErr)
              );
            }
          }
          throw handleApiError(
            rootErr,
            { operation: 'createBranch', npub: context.npub, repo: context.repo },
            `Failed to create repository root directory: ${rootErr instanceof Error ? rootErr.message : String(rootErr)}`
          );
        }
      } else {
        try {
          checkDirectoryWritable(repoRoot, 'GIT_REPO_ROOT directory');
        } catch (checkErr) {
          throw handleApiError(
            checkErr,
            { operation: 'createBranch', npub: context.npub, repo: context.repo },
            checkErr instanceof Error ? checkErr.message : String(checkErr)
          );
        }
      }
      
      // Create repo directory
      const repoDir = dirname(repoPath);
      try {
        await mkdir(repoDir, { recursive: true });
        logger.debug({ repoDir }, 'Created repository directory');
      } catch (dirErr) {
        logger.error({ error: dirErr, repoDir }, 'Failed to create repository directory');
        throw handleApiError(
          dirErr,
          { operation: 'createBranch', npub: context.npub, repo: context.repo },
          `Failed to create repository directory: ${dirErr instanceof Error ? dirErr.message : String(dirErr)}`
        );
      }
      
      // Initialize bare repository
      try {
        const git = simpleGit();
        await git.init(['--bare', repoPath]);
        logger.info({ npub: context.npub, repo: context.repo }, 'Empty repository created successfully');
        // Clear cache
        repoCache.delete(RepoCache.repoExistsKey(context.npub, context.repo));
      } catch (initErr) {
        logger.error({ error: initErr, repoPath }, 'Failed to initialize bare repository');
        throw handleApiError(
          initErr,
          { operation: 'createBranch', npub: context.npub, repo: context.repo },
          `Failed to initialize repository: ${initErr instanceof Error ? initErr.message : String(initErr)}`
        );
      }
    }

    // Check if repo has commits - use multiple verification methods
    logger.info({ npub: context.npub, repo: context.repo, repoPath }, '[Branches POST] Starting commit check');
    let hasCommits = false;
    let commitCount = 0;
    try {
      const git = simpleGit(repoPath);
      logger.info({ npub: context.npub, repo: context.repo }, '[Branches POST] Git instance created for commit check');
      try {
        // Method 1: rev-list count
        logger.info({ npub: context.npub, repo: context.repo }, '[Branches POST] Method 1: Running rev-list --count --all');
        const commitCountStr = await git.raw(['rev-list', '--count', '--all']);
        commitCount = parseInt(commitCountStr.trim(), 10);
        hasCommits = !isNaN(commitCount) && commitCount > 0;
        logger.info({ npub: context.npub, repo: context.repo, commitCountStr, commitCount, hasCommits }, '[Branches POST] Method 1 result: rev-list completed');
        
        // Method 2: Double-check by verifying refs exist
        if (hasCommits) {
          logger.info({ npub: context.npub, repo: context.repo }, '[Branches POST] Method 2: Checking refs (hasCommits=true)');
          try {
            const refs = await git.raw(['for-each-ref', '--count=1', 'refs/heads/']);
            logger.info({ npub: context.npub, repo: context.repo, refs, refsLength: refs?.trim().length }, '[Branches POST] Method 2 result: refs checked');
            if (!refs || refs.trim().length === 0) {
              hasCommits = false;
              logger.warn({ npub: context.npub, repo: context.repo }, '[Branches POST] No refs found despite commit count, treating as empty');
            }
          } catch (refError) {
            hasCommits = false;
            logger.warn({ npub: context.npub, repo: context.repo, error: refError }, '[Branches POST] Method 2 failed: ref check error');
          }
        } else {
          logger.info({ npub: context.npub, repo: context.repo }, '[Branches POST] Skipping Method 2 (hasCommits=false)');
        }
        
        logger.info({ npub: context.npub, repo: context.repo, commitCount, hasCommits }, '[Branches POST] Final commit check result');
      } catch (revListErr) {
        hasCommits = false;
        logger.info({ 
          npub: context.npub, 
          repo: context.repo, 
          error: revListErr,
          errorMessage: revListErr instanceof Error ? revListErr.message : String(revListErr)
        }, '[Branches POST] rev-list failed (empty repo expected)');
      }
    } catch (err) {
      logger.warn({ 
        error: err,
        errorMessage: err instanceof Error ? err.message : String(err),
        npub: context.npub,
        repo: context.repo
      }, '[Branches POST] Failed to check commits, assuming empty');
      hasCommits = false;
    }

    // Determine source branch - CRITICAL: If no commits, NEVER use a source branch
    logger.info({ npub: context.npub, repo: context.repo, hasCommits, fromBranch }, '[Branches POST] Starting source branch determination');
    let sourceBranch: string | undefined = undefined; // Start with undefined
    
    if (hasCommits) {
      logger.info({ npub: context.npub, repo: context.repo }, '[Branches POST] Repo has commits - checking for source branch');
      // Only consider using a source branch if repo has commits
      if (fromBranch) {
        // User explicitly provided a source branch - use it (will be verified in createBranch)
        sourceBranch = fromBranch;
        logger.info({ npub: context.npub, repo: context.repo, sourceBranch }, '[Branches POST] Using provided fromBranch');
      } else {
        // Try to get default branch
        logger.info({ npub: context.npub, repo: context.repo }, '[Branches POST] No fromBranch provided - getting default branch');
        try {
          logger.info({ npub: context.npub, repo: context.repo }, '[Branches POST] Getting existing branches');
          const existingBranches = await fileManager.getBranches(context.npub, context.repo);
          logger.info({ npub: context.npub, repo: context.repo, branchCount: existingBranches.length, branches: existingBranches }, '[Branches POST] Existing branches retrieved');
          if (existingBranches.length > 0) {
            logger.info({ npub: context.npub, repo: context.repo }, '[Branches POST] Getting default branch');
            sourceBranch = await fileManager.getDefaultBranch(context.npub, context.repo);
            logger.info({ npub: context.npub, repo: context.repo, sourceBranch }, '[Branches POST] Got default branch');
          } else {
            sourceBranch = undefined;
            logger.info({ npub: context.npub, repo: context.repo }, '[Branches POST] No branches found, using undefined');
          }
        } catch (err) {
          logger.warn({ 
            error: err,
            errorMessage: err instanceof Error ? err.message : String(err),
            npub: context.npub,
            repo: context.repo
          }, '[Branches POST] Failed to get default branch');
          sourceBranch = undefined;
        }
      }
    } else {
      // No commits - sourceBranch stays undefined
      logger.info({ npub: context.npub, repo: context.repo, hasCommits }, '[Branches POST] Empty repo - sourceBranch will be undefined');
    }
    
    // Final safety check - should never happen but be extra safe
    if (sourceBranch && !hasCommits) {
      logger.error({ sourceBranch, hasCommits, npub: context.npub, repo: context.repo }, '[Branches POST] ERROR: sourceBranch set but no commits! Clearing it.');
      sourceBranch = undefined;
    }
    
    logger.info({ 
      npub: context.npub, 
      repo: context.repo, 
      branchName, 
      sourceBranch, 
      fromBranch,
      hasCommits,
      commitCount
    }, '[Branches POST] ========== FINAL VALUES BEFORE createBranch CALL ==========');
    
    logger.info({ npub: context.npub, repo: context.repo, branchName, sourceBranch }, '[Branches POST] Calling fileManager.createBranch');
    await fileManager.createBranch(context.npub, context.repo, branchName, sourceBranch);
    logger.info({ npub: context.npub, repo: context.repo, branchName }, '[Branches POST] ========== SUCCESS ==========');
    return json({ success: true, message: 'Branch created successfully' });
  },
  { operation: 'createBranch', requireRepoExists: false, requireMaintainer: false }
);

/**
 * DELETE: Delete a branch
 */
export const DELETE: RequestHandler = createRepoPostHandler(
  async (context: RepoRequestContext, event: RequestEvent) => {
    const body = await event.request.json();
    const { branchName } = body;

    if (!branchName) {
      throw handleValidationError('Missing branchName parameter', { operation: 'deleteBranch', npub: context.npub, repo: context.repo });
    }

    await fileManager.deleteBranch(context.npub, context.repo, branchName);
    return json({ success: true, message: 'Branch deleted successfully' });
  },
  { operation: 'deleteBranch' }
);
