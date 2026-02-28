/**
 * RESTful Files Resource Endpoint
 * 
 * GET    /api/repos/{npub}/{repo}/files                # List files (tree view) or get file content
 * GET    /api/repos/{npub}/{repo}/files/{path}        # Get file content
 * POST   /api/repos/{npub}/{repo}/files/{path}        # Create file
 * PUT    /api/repos/{npub}/{repo}/files/{path}        # Update file (replace)
 * PATCH  /api/repos/{npub}/{repo}/files/{path}        # Partial update
 * DELETE /api/repos/{npub}/{repo}/files/{path}        # Delete file
 * 
 * Query parameters:
 *   - ?action=tree - List files (tree view)
 *   - ?path=... - File path (for GET without path param)
 *   - ?format=raw - Get raw content (no JSON wrapper)
 *   - ?format=json - Get JSON with metadata (default)
 *   - ?branch=main - Specify branch
 *   - ?recursive=true - For tree listing, include subdirectories
 */

import { json, error } from '@sveltejs/kit';
// @ts-ignore - SvelteKit generates this type
import type { RequestHandler } from './$types';
import { createRepoGetHandler, createRepoPostHandler } from '$lib/utils/api-handlers.js';
import type { RepoRequestContext, RequestEvent } from '$lib/utils/api-context.js';
import { handleApiError, handleValidationError, handleNotFoundError } from '$lib/utils/error-handler.js';
import { fileManager, repoManager, nostrClient } from '$lib/services/service-registry.js';
import { MaintainerService } from '$lib/services/nostr/maintainer-service.js';
import { DEFAULT_NOSTR_RELAYS } from '$lib/config.js';
import { nip19 } from 'nostr-tools';
import { verifyNIP98Auth } from '$lib/services/nostr/nip98-auth.js';
import { requireNpubHex, decodeNpubToHex } from '$lib/utils/npub-utils.js';
import { extractRequestContext } from '$lib/utils/api-context.js';
import { fetchUserEmail, fetchUserName } from '$lib/utils/user-profile.js';
import { auditLogger } from '$lib/services/security/audit-logger.js';
import logger from '$lib/services/logger.js';
import type { NostrEvent } from '$lib/types/nostr.js';
import { eventCache } from '$lib/services/nostr/event-cache.js';
import { fetchRepoAnnouncementsWithCache, findRepoAnnouncement } from '$lib/utils/nostr-utils.js';
import { repoCache, RepoCache } from '$lib/services/git/repo-cache.js';
import { join, resolve } from 'path';
import { existsSync } from 'fs';
import { spawn } from 'child_process';

const repoRootEnv = typeof process !== 'undefined' && process.env?.GIT_REPO_ROOT
  ? process.env.GIT_REPO_ROOT
  : '/repos';
const repoRoot = resolve(repoRootEnv);
const maintainerService = new MaintainerService(DEFAULT_NOSTR_RELAYS);

// Check if a file extension is a binary image type
function isBinaryImage(ext: string): boolean {
  const binaryImageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'apng', 'avif'];
  return binaryImageExtensions.includes(ext.toLowerCase());
}

/**
 * GET: List files (tree) or get file content
 * Query params: ?action=tree, ?path=..., ?format=raw, ?branch=...
 */
export const GET: RequestHandler = createRepoGetHandler(
  async (context: RepoRequestContext, event: RequestEvent) => {
    const url = new URL(event.request.url);
    const action = url.searchParams.get('action');
    const filePath = url.searchParams.get('path') || context.path;
    const format = url.searchParams.get('format') || 'json';
    const ref = url.searchParams.get('branch') || url.searchParams.get('ref') || context.ref || 'HEAD';
    const recursive = url.searchParams.get('recursive') === 'true';

    // If action=tree or no path specified, list files (tree view)
    if (action === 'tree' || !filePath) {
      return handleTreeListing(context, ref);
    }

    // If format=raw, return raw file content
    if (format === 'raw') {
      return handleRawFileContent(context, event, filePath, ref);
    }

    // Otherwise, return JSON file content with metadata
    return handleJsonFileContent(context, event, filePath, ref);
  },
  { operation: 'getFiles', requireRepoExists: false, requireRepoAccess: false }
);

/**
 * Handle tree listing (from tree endpoint)
 */
async function handleTreeListing(context: RepoRequestContext, ref: string) {
  const repoPath = join(repoRoot, context.npub, `${context.repo}.git`);
  
  // If repo doesn't exist, try to fetch it on-demand
  if (!existsSync(repoPath)) {
    try {
      // Fetch repository announcement from Nostr (case-insensitive) with caching
      const allEvents = await fetchRepoAnnouncementsWithCache(nostrClient, context.repoOwnerPubkey, eventCache);
      const announcement = findRepoAnnouncement(allEvents, context.repo);

      if (announcement) {
        // Try API-based fetching first (no cloning)
        const { tryApiFetch } = await import('$lib/utils/api-repo-helper.js');
        const { extractCloneUrls: extractCloneUrlsHelper } = await import('$lib/utils/nostr-utils.js');
        const cloneUrlsForLogging = extractCloneUrlsHelper(announcement);
        
        logger.debug({ npub: context.npub, repo: context.repo, cloneUrlCount: cloneUrlsForLogging.length, cloneUrls: cloneUrlsForLogging, path: context.path }, 'Attempting API fallback for tree');
        
        const apiData = await tryApiFetch(announcement, context.npub, context.repo);
        
        if (apiData && apiData.files !== undefined) {
          // Return empty array if no files (legitimate for empty repos)
          if (apiData.files.length === 0) {
            logger.debug({ npub: context.npub, repo: context.repo, path: context.path }, 'API fallback returned empty files array (repo may be empty)');
            return json([]);
          }
          logger.debug({ npub: context.npub, repo: context.repo, fileCount: apiData.files.length }, 'Successfully fetched files via API fallback');
          
          // Filter files by path if specified
          const path = context.path || '';
          let filteredFiles: typeof apiData.files;
          if (path) {
            const normalizedPath = path.endsWith('/') ? path : `${path}/`;
            filteredFiles = apiData.files.filter(f => {
              if (!f.path.startsWith(normalizedPath)) {
                return false;
              }
              const relativePath = f.path.slice(normalizedPath.length);
              if (!relativePath) {
                return false;
              }
              const cleanRelativePath = relativePath.endsWith('/') ? relativePath.slice(0, -1) : relativePath;
              return !cleanRelativePath.includes('/');
            });
          } else {
            filteredFiles = apiData.files.filter(f => {
              const cleanPath = f.path.endsWith('/') ? f.path.slice(0, -1) : f.path;
              const pathParts = cleanPath.split('/');
              return pathParts.length === 1;
            });
          }
          
          // Normalize type: API returns 'dir' but frontend expects 'directory'
          const normalizedFiles = filteredFiles.map(f => {
            const cleanPath = f.path.endsWith('/') ? f.path.slice(0, -1) : f.path;
            const pathParts = cleanPath.split('/');
            const displayName = pathParts[pathParts.length - 1] || f.name;
            return {
              name: displayName,
              path: f.path,
              type: (f.type === 'dir' ? 'directory' : 'file') as 'file' | 'directory',
              size: f.size
            };
          });
          
          return json(normalizedFiles);
        }
        
        // API fetch failed
        const { extractCloneUrls } = await import('$lib/utils/nostr-utils.js');
        const cloneUrls = extractCloneUrls(announcement);
        const hasCloneUrls = cloneUrls.length > 0;
        
        logger.debug({ npub: context.npub, repo: context.repo, hasCloneUrls, cloneUrlCount: cloneUrls.length }, 'API fallback failed or no clone URLs available');
        
        throw handleNotFoundError(
          hasCloneUrls 
            ? 'Repository is not cloned locally and could not be fetched via API. Privileged users can clone this repository using the "Clone to Server" button.'
            : 'Repository is not cloned locally and has no external clone URLs for API fallback. Privileged users can clone this repository using the "Clone to Server" button.',
          { operation: 'listFiles', npub: context.npub, repo: context.repo }
        );
      } else {
        throw handleNotFoundError(
          'Repository announcement not found in Nostr',
          { operation: 'listFiles', npub: context.npub, repo: context.repo }
        );
      }
    } catch (err) {
      // Check if repo was created by another concurrent request
      if (existsSync(repoPath)) {
        repoCache.delete(RepoCache.repoExistsKey(context.npub, context.repo));
      } else {
        if (err instanceof Response) {
          return err;
        }
        throw handleNotFoundError(
          'Repository not found',
          { operation: 'listFiles', npub: context.npub, repo: context.repo }
        );
      }
    }
  }

  // Double-check repo exists
  if (!existsSync(repoPath)) {
    throw handleNotFoundError(
      'Repository not found',
      { operation: 'listFiles', npub: context.npub, repo: context.repo }
    );
  }

  // Get default branch if no ref specified
  let finalRef = ref;
  if (finalRef !== 'HEAD' && !finalRef.startsWith('refs/')) {
    try {
      const branches = await fileManager.getBranches(context.npub, context.repo);
      if (!branches.includes(finalRef)) {
        finalRef = await fileManager.getDefaultBranch(context.npub, context.repo);
      }
    } catch {
      finalRef = 'HEAD';
    }
  }
  const path = context.path || '';
  
  try {
    const files = await fileManager.listFiles(context.npub, context.repo, finalRef, path);
    
    // If repo exists but has no files (empty repo), try API fallback
    if (files.length === 0) {
      logger.debug({ npub: context.npub, repo: context.repo, path, ref: finalRef }, 'Repo exists but is empty, attempting API fallback for tree');
      
      try {
        const allEvents = await fetchRepoAnnouncementsWithCache(nostrClient, context.repoOwnerPubkey, eventCache);
        const announcement = findRepoAnnouncement(allEvents, context.repo);
        
        if (announcement) {
          const { tryApiFetch } = await import('$lib/utils/api-repo-helper.js');
          const apiData = await tryApiFetch(announcement, context.npub, context.repo);
          
          if (apiData && apiData.files && apiData.files.length > 0) {
            logger.info({ npub: context.npub, repo: context.repo, fileCount: apiData.files.length }, 'Successfully fetched files via API fallback for empty repo');
            
            // Filter files by path if specified
            let filteredFiles: typeof apiData.files;
            if (path) {
              const normalizedPath = path.endsWith('/') ? path : `${path}/`;
              filteredFiles = apiData.files.filter(f => {
                if (!f.path.startsWith(normalizedPath)) {
                  return false;
                }
                const relativePath = f.path.slice(normalizedPath.length);
                if (!relativePath) {
                  return false;
                }
                const cleanRelativePath = relativePath.endsWith('/') ? relativePath.slice(0, -1) : relativePath;
                return !cleanRelativePath.includes('/');
              });
            } else {
              filteredFiles = apiData.files.filter(f => {
                const cleanPath = f.path.endsWith('/') ? f.path.slice(0, -1) : f.path;
                const pathParts = cleanPath.split('/');
                return pathParts.length === 1;
              });
            }
            
            // Normalize type and name
            const normalizedFiles = filteredFiles.map(f => {
              const cleanPath = f.path.endsWith('/') ? f.path.slice(0, -1) : f.path;
              const pathParts = cleanPath.split('/');
              const displayName = pathParts[pathParts.length - 1] || f.name;
              return {
                name: displayName,
                path: f.path,
                type: (f.type === 'dir' ? 'directory' : 'file') as 'file' | 'directory',
                size: f.size
              };
            });
            
            return json(normalizedFiles);
          }
        }
      } catch (apiErr) {
        logger.debug({ error: apiErr, npub: context.npub, repo: context.repo }, 'API fallback failed for empty repo, returning empty files');
      }
    }
    
    logger.debug({ 
      npub: context.npub, 
      repo: context.repo, 
      path, 
      ref: finalRef, 
      fileCount: files.length,
      files: files.map(f => ({ name: f.name, path: f.path, type: f.type }))
    }, '[Tree] Returning files from fileManager.listFiles');
    return json(files);
  } catch (err) {
    // Try API fallback before giving up
    logger.debug({ error: err, npub: context.npub, repo: context.repo }, '[Tree] Error listing files, attempting API fallback');
    
    try {
      const allEvents = await fetchRepoAnnouncementsWithCache(nostrClient, context.repoOwnerPubkey, eventCache);
      const announcement = findRepoAnnouncement(allEvents, context.repo);
      
      if (announcement) {
        const { tryApiFetch } = await import('$lib/utils/api-repo-helper.js');
        const apiData = await tryApiFetch(announcement, context.npub, context.repo);
        
        if (apiData && apiData.files && apiData.files.length > 0) {
          logger.info({ npub: context.npub, repo: context.repo, fileCount: apiData.files.length }, 'Successfully fetched files via API fallback after error');
          
          // Filter and normalize files
          const path = context.path || '';
          let filteredFiles: typeof apiData.files;
          if (path) {
            const normalizedPath = path.endsWith('/') ? path : `${path}/`;
            filteredFiles = apiData.files.filter(f => {
              if (!f.path.startsWith(normalizedPath)) return false;
              const relativePath = f.path.slice(normalizedPath.length);
              if (!relativePath) return false;
              const cleanRelativePath = relativePath.endsWith('/') ? relativePath.slice(0, -1) : relativePath;
              return !cleanRelativePath.includes('/');
            });
          } else {
            filteredFiles = apiData.files.filter(f => {
              const cleanPath = f.path.endsWith('/') ? f.path.slice(0, -1) : f.path;
              return cleanPath.split('/').length === 1;
            });
          }
          
          const normalizedFiles = filteredFiles.map(f => {
            const cleanPath = f.path.endsWith('/') ? f.path.slice(0, -1) : f.path;
            const pathParts = cleanPath.split('/');
            const displayName = pathParts[pathParts.length - 1] || f.name;
            return {
              name: displayName,
              path: f.path,
              type: (f.type === 'dir' ? 'directory' : 'file') as 'file' | 'directory',
              size: f.size
            };
          });
          
          return json(normalizedFiles);
        }
      }
    } catch (apiErr) {
      logger.debug({ error: apiErr, npub: context.npub, repo: context.repo }, 'API fallback failed after error');
    }
    
    logger.error({ error: err, npub: context.npub, repo: context.repo, path: context.path }, '[Tree] Error listing files');
    
    // For optional paths, return empty array instead of 404
    const optionalPaths = ['docs'];
    if (context.path && optionalPaths.includes(context.path.toLowerCase())) {
      logger.debug({ npub: context.npub, repo: context.repo, path: context.path }, '[Tree] Optional path not found, returning empty array');
      return json([]);
    }
    
    // Check if it's a "not found" error for the repo itself
    if (err instanceof Error && (err.message.includes('Repository not found') || err.message.includes('not cloned'))) {
      throw handleNotFoundError(
        err.message,
        { operation: 'listFiles', npub: context.npub, repo: context.repo }
      );
    }
    
    // For other errors with optional paths, return empty array
    if (context.path && optionalPaths.includes(context.path.toLowerCase())) {
      return json([]);
    }
    
    // Otherwise, it's a server error
    throw handleApiError(
      err,
      { operation: 'listFiles', npub: context.npub, repo: context.repo },
      'Failed to list files'
    );
  }
}

/**
 * Handle raw file content (from raw endpoint)
 */
async function handleRawFileContent(
  context: RepoRequestContext,
  event: RequestEvent,
  filePath: string,
  ref: string
) {
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
}

/**
 * Handle JSON file content (from file endpoint)
 */
async function handleJsonFileContent(
  context: RepoRequestContext,
  event: RequestEvent,
  filePath: string,
  ref: string
) {
  if (!filePath) {
    return error(400, 'Missing path parameter');
  }

  const requestContext = extractRequestContext(event);
  const userPubkey = requestContext.userPubkey;
  const userPubkeyHex = requestContext.userPubkeyHex;
  
  logger.debug({ 
    hasUserPubkey: !!userPubkey, 
    hasUserPubkeyHex: !!userPubkeyHex,
    userPubkeyHex: userPubkeyHex ? userPubkeyHex.substring(0, 16) + '...' : null,
    npub: context.npub, 
    repo: context.repo, 
    filePath 
  }, 'File endpoint - extracted user context');

  const repoPath = join(repoRoot, context.npub, `${context.repo}.git`);
  
  // If repo doesn't exist, try to fetch it on-demand
  if (!existsSync(repoPath)) {
    try {
      let repoOwnerPubkey: string;
      try {
        repoOwnerPubkey = requireNpubHex(context.npub);
      } catch {
        return error(400, 'Invalid npub format');
      }

      // Fetch repository announcement (case-insensitive) with caching
      const allEvents = await fetchRepoAnnouncementsWithCache(nostrClient, repoOwnerPubkey, eventCache);
      const announcement = findRepoAnnouncement(allEvents, context.repo);

      if (announcement) {
        // Try API-based fetching first (no cloning)
        try {
          const { tryApiFetchFile } = await import('$lib/utils/api-repo-helper.js');
          const fileContent = await tryApiFetchFile(announcement, context.npub, context.repo, filePath, ref);
          
          if (fileContent && fileContent.content) {
            logger.debug({ npub: context.npub, repo: context.repo, filePath, ref }, 'Successfully fetched file via API fallback');
            return json(fileContent);
          }
        } catch (apiErr) {
          logger.debug({ error: apiErr, npub: context.npub, repo: context.repo, filePath, ref }, 'API file fetch failed, will return 404');
        }
        
        // API fetch failed
        const { extractCloneUrls } = await import('$lib/utils/nostr-utils.js');
        const cloneUrls = extractCloneUrls(announcement);
        const hasCloneUrls = cloneUrls.length > 0;
        
        logger.debug({ npub: context.npub, repo: context.repo, filePath, hasCloneUrls, cloneUrlCount: cloneUrls.length }, 'API fallback failed or no clone URLs available');
        
        return error(404, hasCloneUrls 
          ? 'Repository is not cloned locally and could not fetch file via API. Privileged users can clone this repository using the "Clone to Server" button.'
          : 'Repository is not cloned locally and has no external clone URLs for API fallback. Privileged users can clone this repository using the "Clone to Server" button.');
      } else {
        return error(404, 'Repository announcement not found in Nostr');
      }
    } catch (err) {
      logger.error({ error: err, npub: context.npub, repo: context.repo, filePath }, 'Error in on-demand file fetch');
      // Check if repo was created by another concurrent request
      if (existsSync(repoPath)) {
        repoCache.delete(RepoCache.repoExistsKey(context.npub, context.repo));
      } else {
        return error(404, 'Repository not found');
      }
    }
  }

  // Double-check repo exists
  if (!existsSync(repoPath)) {
    return error(404, 'Repository not found');
  }

  // Get repo owner pubkey for access check
  let repoOwnerPubkey: string;
  try {
    repoOwnerPubkey = requireNpubHex(context.npub);
  } catch {
    return error(400, 'Invalid npub format');
  }

  // If ref is a branch name, validate it exists or use default branch
  let finalRef = ref;
  if (finalRef !== 'HEAD' && !finalRef.startsWith('refs/')) {
    try {
      const branches = await fileManager.getBranches(context.npub, context.repo);
      if (!branches.includes(finalRef)) {
        try {
          finalRef = await fileManager.getDefaultBranch(context.npub, context.repo);
          logger.debug({ npub: context.npub, repo: context.repo, originalRef: ref, newRef: finalRef }, 'Branch not found, using default branch');
        } catch (defaultBranchErr) {
          logger.warn({ error: defaultBranchErr, npub: context.npub, repo: context.repo, ref }, 'Could not get default branch, falling back to HEAD');
          finalRef = 'HEAD';
        }
      }
    } catch (branchErr) {
      logger.warn({ error: branchErr, npub: context.npub, repo: context.repo, ref }, 'Could not get branches, falling back to HEAD');
      finalRef = 'HEAD';
    }
  }

  // Check repository privacy
  logger.debug({ 
    userPubkeyHex: userPubkeyHex ? userPubkeyHex.substring(0, 16) + '...' : null,
    repoOwnerPubkey: repoOwnerPubkey.substring(0, 16) + '...',
    repo: context.repo 
  }, 'File endpoint - checking canView before access check');
  
  const canView = await maintainerService.canView(userPubkeyHex || null, repoOwnerPubkey, context.repo);
  
  logger.debug({ 
    canView, 
    userPubkeyHex: userPubkeyHex ? userPubkeyHex.substring(0, 16) + '...' : null,
    repoOwnerPubkey: repoOwnerPubkey.substring(0, 16) + '...',
    repo: context.repo 
  }, 'File endpoint - canView result');
  
  if (!canView) {
    auditLogger.logFileOperation(
      userPubkeyHex || null,
      requestContext.clientIp,
      'read',
      `${context.npub}/${context.repo}`,
      filePath,
      'denied',
      'Insufficient permissions'
    );
    return error(403, 'This repository is private. Only owners and maintainers can view it.');
  }

  try {
    logger.debug({ npub: context.npub, repo: context.repo, filePath, ref: finalRef }, 'Attempting to read file from cloned repository');
    
    let fileContent;
    try {
      fileContent = await fileManager.getFileContent(context.npub, context.repo, filePath, finalRef);
    } catch (firstErr) {
      // If the first attempt fails and ref is not HEAD, try with HEAD as fallback
      if (finalRef !== 'HEAD' && !finalRef.startsWith('refs/')) {
        logger.warn({ 
          error: firstErr, 
          npub: context.npub, 
          repo: context.repo, 
          filePath, 
          originalRef: finalRef 
        }, 'Failed to read file with specified ref, trying HEAD as fallback');
        try {
          fileContent = await fileManager.getFileContent(context.npub, context.repo, filePath, 'HEAD');
          finalRef = 'HEAD';
        } catch (headErr) {
          // If HEAD also fails, try API fallback before throwing
          logger.debug({ error: headErr, npub: context.npub, repo: context.repo, filePath }, 'Failed to read file from local repo, attempting API fallback');
          
          try {
            const allEvents = await fetchRepoAnnouncementsWithCache(nostrClient, repoOwnerPubkey, eventCache);
            const announcement = findRepoAnnouncement(allEvents, context.repo);
            
            if (announcement) {
              const { tryApiFetchFile } = await import('$lib/utils/api-repo-helper.js');
              const apiRef = ref === 'HEAD' ? 'main' : ref;
              const apiFileContent = await tryApiFetchFile(announcement, context.npub, context.repo, filePath, apiRef);
              
              if (apiFileContent && apiFileContent.content) {
                logger.info({ npub: context.npub, repo: context.repo, filePath, ref: apiRef }, 'Successfully fetched file via API fallback for empty repo');
                auditLogger.logFileOperation(
                  userPubkeyHex || null,
                  requestContext.clientIp,
                  'read',
                  `${context.npub}/${context.repo}`,
                  filePath,
                  'success'
                );
                return json(apiFileContent);
              }
            }
          } catch (apiErr) {
            logger.debug({ error: apiErr, npub: context.npub, repo: context.repo, filePath }, 'API fallback failed for file');
          }
          
          throw firstErr;
        }
      } else {
        // Try API fallback before throwing
        logger.debug({ error: firstErr, npub: context.npub, repo: context.repo, filePath }, 'Failed to read file from local repo, attempting API fallback');
        
        try {
          const allEvents = await fetchRepoAnnouncementsWithCache(nostrClient, repoOwnerPubkey, eventCache);
          const announcement = findRepoAnnouncement(allEvents, context.repo);
          
          if (announcement) {
            const { tryApiFetchFile } = await import('$lib/utils/api-repo-helper.js');
            const apiRef = finalRef === 'HEAD' ? 'main' : finalRef;
            const apiFileContent = await tryApiFetchFile(announcement, context.npub, context.repo, filePath, apiRef);
            
            if (apiFileContent && apiFileContent.content) {
              logger.info({ npub: context.npub, repo: context.repo, filePath, ref: apiRef }, 'Successfully fetched file via API fallback for empty repo');
              auditLogger.logFileOperation(
                userPubkeyHex || null,
                requestContext.clientIp,
                'read',
                `${context.npub}/${context.repo}`,
                filePath,
                'success'
              );
              return json(apiFileContent);
            }
          }
        } catch (apiErr) {
          logger.debug({ error: apiErr, npub: context.npub, repo: context.repo, filePath }, 'API fallback failed for file');
        }
        
        throw firstErr;
      }
    }
    
    auditLogger.logFileOperation(
      userPubkeyHex || null,
      requestContext.clientIp,
      'read',
      `${context.npub}/${context.repo}`,
      filePath,
      'success'
    );
    return json(fileContent);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorLower = errorMessage.toLowerCase();
    const errorStack = err instanceof Error ? err.stack : undefined;
    
    logger.error({ 
      error: err, 
      errorStack,
      npub: context.npub, 
      repo: context.repo, 
      filePath, 
      ref: finalRef,
      repoExists: existsSync(repoPath),
      errorMessage
    }, 'Error reading file from cloned repository');
    auditLogger.logFileOperation(
      userPubkeyHex || null,
      requestContext.clientIp,
      'read',
      `${context.npub}/${context.repo}`,
      filePath,
      'failure',
      errorMessage
    );
    // If file not found or path doesn't exist, return 404 instead of 500
    if (errorLower.includes('not found') || 
        errorLower.includes('no such file') || 
        errorLower.includes('does not exist') ||
        errorLower.includes('fatal:') ||
        errorMessage.includes('pathspec')) {
      return error(404, `File not found: ${filePath} at ref ${finalRef}`);
    }
    // For other errors, return 500 with a more helpful message
    return error(500, `Failed to read file: ${errorMessage}`);
  }
}

/**
 * POST: Create file
 */
export const POST: RequestHandler = createRepoPostHandler(
  async (context: RepoRequestContext, event: RequestEvent) => {
    return handleFileWrite(context, event, 'create');
  },
  { operation: 'createFile', requireRepoExists: true, requireRepoAccess: true }
);

/**
 * PUT: Update file (replace)
 */
export const PUT: RequestHandler = createRepoPostHandler(
  async (context: RepoRequestContext, event: RequestEvent) => {
    return handleFileWrite(context, event, 'update');
  },
  { operation: 'updateFile', requireRepoExists: true, requireRepoAccess: true }
);

/**
 * PATCH: Partial update (not implemented yet, same as PUT)
 */
export const PATCH: RequestHandler = createRepoPostHandler(
  async (context: RepoRequestContext, event: RequestEvent) => {
    // PATCH not yet implemented - use PUT for now
    return handleFileWrite(context, event, 'update');
  },
  { operation: 'patchFile', requireRepoExists: true, requireRepoAccess: true }
);

/**
 * DELETE: Delete file
 */
export const DELETE: RequestHandler = createRepoPostHandler(
  async (context: RepoRequestContext, event: RequestEvent) => {
    return handleFileDelete(context, event);
  },
  { operation: 'deleteFile', requireRepoExists: true, requireRepoAccess: true }
);

/**
 * Handle file write operations (create/update)
 */
async function handleFileWrite(
  context: RepoRequestContext,
  event: RequestEvent,
  action: 'create' | 'update'
) {
  const filePath = context.path || new URL(event.request.url).searchParams.get('path');
  
  if (!filePath) {
    return error(400, 'Missing path parameter');
  }

  let body: {
    path?: string;
    content?: string;
    commitMessage?: string;
    authorName?: string;
    authorEmail?: string;
    branch?: string;
    userPubkey?: string;
    useNIP07?: boolean;
    nsecKey?: string;
    commitSignatureEvent?: NostrEvent;
  };

  try {
    body = await event.request.json();
  } catch {
    return error(400, 'Invalid JSON in request body');
  }

  const { content, commitMessage, authorName, authorEmail, branch, userPubkey, useNIP07, nsecKey, commitSignatureEvent } = body;
  
  // Check for NIP-98 authentication (for git operations)
  const authHeader = event.request.headers.get('Authorization');
  let nip98Event = null;
  if (authHeader && authHeader.startsWith('Nostr ')) {
    const requestUrl = `${event.request.headers.get('x-forwarded-proto') || (event.url.protocol === 'https:' ? 'https' : 'http')}://${event.request.headers.get('host') || event.url.host}${event.url.pathname}${event.url.search}`;
    const authResult = verifyNIP98Auth(authHeader, requestUrl, event.request.method);
    if (authResult.valid && authResult.event) {
      nip98Event = authResult.event;
    }
  }

  if (!commitMessage) {
    return error(400, 'Missing required field: commitMessage');
  }

  if (action === 'create' && content === undefined) {
    return error(400, 'Content is required for create operations');
  }

  if (action === 'update' && content === undefined) {
    return error(400, 'Content is required for update operations');
  }

  // Fetch authorName and authorEmail from kind 0 event if not provided
  let finalAuthorName = authorName;
  let finalAuthorEmail = authorEmail;

  if (!finalAuthorName || !finalAuthorEmail) {
    if (!userPubkey) {
      return error(400, 'Missing userPubkey. Cannot fetch author information without userPubkey.');
    }

    const userPubkeyHexForProfile = decodeNpubToHex(userPubkey) || userPubkey;
    
    try {
      if (!finalAuthorName) {
        finalAuthorName = await fetchUserName(userPubkeyHexForProfile, userPubkey, DEFAULT_NOSTR_RELAYS);
      }
      if (!finalAuthorEmail) {
        finalAuthorEmail = await fetchUserEmail(userPubkeyHexForProfile, userPubkey, DEFAULT_NOSTR_RELAYS);
      }
    } catch (err) {
      logger.warn({ error: err, userPubkey }, 'Failed to fetch user profile for author info, using fallbacks');
      // Use fallbacks if fetch fails
      if (!finalAuthorName) {
        const npub = userPubkey.startsWith('npub') ? userPubkey : nip19.npubEncode(userPubkeyHexForProfile);
        finalAuthorName = npub.substring(0, 20);
      }
      if (!finalAuthorEmail) {
        const npub = userPubkey.startsWith('npub') ? userPubkey : nip19.npubEncode(userPubkeyHexForProfile);
        finalAuthorEmail = `${npub.substring(0, 20)}@gitrepublic.web`;
      }
    }
  }

  if (!userPubkey) {
    return error(401, 'Authentication required. Please provide userPubkey.');
  }

  // Check if repo exists locally
  if (!fileManager.repoExists(context.npub, context.repo)) {
    // Try to fetch announcement to see if repo exists in Nostr
    let repoOwnerPubkey: string;
    try {
      repoOwnerPubkey = requireNpubHex(context.npub);
    } catch {
      return error(400, 'Invalid npub format');
    }

    // Fetch repository announcement (case-insensitive) with caching
    const allEvents = await fetchRepoAnnouncementsWithCache(nostrClient, repoOwnerPubkey, eventCache);
    const announcement = findRepoAnnouncement(allEvents, context.repo);

    if (announcement) {
      // Repository exists in Nostr but is not cloned locally
      // For file editing, we need a local clone
      return error(404, 'Repository is not cloned locally. To edit files, the repository must be cloned to the server first. Please use the "Clone to Server" button if you have unlimited access, or contact a server administrator.');
    } else {
      return error(404, 'Repository not found');
    }
  }

  // Check if user is a maintainer
  let repoOwnerPubkey: string;
  try {
    repoOwnerPubkey = requireNpubHex(context.npub);
  } catch {
    return error(400, 'Invalid npub format');
  }

  // Convert userPubkey to hex if needed
  const userPubkeyHex = decodeNpubToHex(userPubkey) || userPubkey;

  const isMaintainer = await maintainerService.isMaintainer(userPubkeyHex, repoOwnerPubkey, context.repo);
  if (!isMaintainer) {
    return error(403, 'Only repository maintainers can edit files directly. Please submit a pull request instead.');
  }

  // Prepare signing options
  const signingOptions: {
    useNIP07?: boolean;
    nip98Event?: NostrEvent;
    nsecKey?: string;
    commitSignatureEvent?: NostrEvent;
  } = {};
  
  // If client sent a pre-signed commit signature event (from NIP-07), use it
  if (commitSignatureEvent && commitSignatureEvent.sig && commitSignatureEvent.id) {
    signingOptions.commitSignatureEvent = commitSignatureEvent;
  } else if (nip98Event) {
    signingOptions.nip98Event = nip98Event;
  }
  
  // Explicitly ignore nsecKey from client requests - it's a security risk
  if (nsecKey) {
    const clientIp = event.request.headers.get('x-forwarded-for') || event.request.headers.get('x-real-ip') || 'unknown';
    logger.warn({ clientIp, npub: context.npub, repo: context.repo }, '[SECURITY] Client attempted to send nsecKey in request. This is not allowed for security reasons.');
    auditLogger.log({
      user: userPubkeyHex || undefined,
      ip: clientIp,
      action: 'auth_attempt',
      resource: 'file_operation',
      result: 'failure',
      error: 'Client attempted to send private key in request body',
      metadata: { reason: 'security_violation' }
    });
  }

  const clientIp = event.request.headers.get('x-forwarded-for') || event.request.headers.get('x-real-ip') || 'unknown';
  
  try {
    // Get default branch if not provided
    const targetBranch = branch || await fileManager.getDefaultBranch(context.npub, context.repo);
    
    await fileManager.writeFile(
      context.npub,
      context.repo,
      filePath,
      content!,
      commitMessage,
      finalAuthorName!,
      finalAuthorEmail!,
      targetBranch,
      Object.keys(signingOptions).length > 0 ? signingOptions : undefined
    );
    auditLogger.logFileOperation(
      userPubkeyHex,
      clientIp,
      action === 'create' ? 'create' : 'write',
      `${context.npub}/${context.repo}`,
      filePath,
      'success'
    );
    return json({ success: true, message: 'File saved and committed' });
  } catch (err) {
    auditLogger.logFileOperation(
      userPubkeyHex,
      clientIp,
      action === 'create' ? 'create' : 'write',
      `${context.npub}/${context.repo}`,
      filePath,
      'failure',
      err instanceof Error ? err.message : String(err)
    );
    return handleApiError(err, { operation: 'writeFile', npub: context.npub, repo: context.repo, filePath }, 'Failed to write file');
  }
}

/**
 * Handle file deletion
 */
async function handleFileDelete(
  context: RepoRequestContext,
  event: RequestEvent
) {
  const filePath = context.path || new URL(event.request.url).searchParams.get('path');
  
  if (!filePath) {
    return error(400, 'Missing path parameter');
  }

  let body: {
    path?: string;
    commitMessage?: string;
    authorName?: string;
    authorEmail?: string;
    branch?: string;
    userPubkey?: string;
    nsecKey?: string;
    commitSignatureEvent?: NostrEvent;
  };

  try {
    body = await event.request.json();
  } catch {
    return error(400, 'Invalid JSON in request body');
  }

  const { commitMessage, authorName, authorEmail, branch, userPubkey, nsecKey, commitSignatureEvent } = body;
  
  // Check for NIP-98 authentication
  const authHeader = event.request.headers.get('Authorization');
  let nip98Event = null;
  if (authHeader && authHeader.startsWith('Nostr ')) {
    const requestUrl = `${event.request.headers.get('x-forwarded-proto') || (event.url.protocol === 'https:' ? 'https' : 'http')}://${event.request.headers.get('host') || event.url.host}${event.url.pathname}${event.url.search}`;
    const authResult = verifyNIP98Auth(authHeader, requestUrl, event.request.method);
    if (authResult.valid && authResult.event) {
      nip98Event = authResult.event;
    }
  }

  if (!commitMessage) {
    return error(400, 'Missing required field: commitMessage');
  }

  if (!userPubkey) {
    return error(401, 'Authentication required. Please provide userPubkey.');
  }

  // Fetch authorName and authorEmail from kind 0 event if not provided
  let finalAuthorName = authorName;
  let finalAuthorEmail = authorEmail;

  if (!finalAuthorName || !finalAuthorEmail) {
    const userPubkeyHexForProfile = decodeNpubToHex(userPubkey) || userPubkey;
    
    try {
      if (!finalAuthorName) {
        finalAuthorName = await fetchUserName(userPubkeyHexForProfile, userPubkey, DEFAULT_NOSTR_RELAYS);
      }
      if (!finalAuthorEmail) {
        finalAuthorEmail = await fetchUserEmail(userPubkeyHexForProfile, userPubkey, DEFAULT_NOSTR_RELAYS);
      }
    } catch (err) {
      logger.warn({ error: err, userPubkey }, 'Failed to fetch user profile for author info, using fallbacks');
      if (!finalAuthorName) {
        const npub = userPubkey.startsWith('npub') ? userPubkey : nip19.npubEncode(userPubkeyHexForProfile);
        finalAuthorName = npub.substring(0, 20);
      }
      if (!finalAuthorEmail) {
        const npub = userPubkey.startsWith('npub') ? userPubkey : nip19.npubEncode(userPubkeyHexForProfile);
        finalAuthorEmail = `${npub.substring(0, 20)}@gitrepublic.web`;
      }
    }
  }

  // Check if repo exists locally
  if (!fileManager.repoExists(context.npub, context.repo)) {
    let repoOwnerPubkey: string;
    try {
      repoOwnerPubkey = requireNpubHex(context.npub);
    } catch {
      return error(400, 'Invalid npub format');
    }

    const allEvents = await fetchRepoAnnouncementsWithCache(nostrClient, repoOwnerPubkey, eventCache);
    const announcement = findRepoAnnouncement(allEvents, context.repo);

    if (announcement) {
      return error(404, 'Repository is not cloned locally. To delete files, the repository must be cloned to the server first.');
    } else {
      return error(404, 'Repository not found');
    }
  }

  // Check if user is a maintainer
  let repoOwnerPubkey: string;
  try {
    repoOwnerPubkey = requireNpubHex(context.npub);
  } catch {
    return error(400, 'Invalid npub format');
  }

  const userPubkeyHex = decodeNpubToHex(userPubkey) || userPubkey;

  const isMaintainer = await maintainerService.isMaintainer(userPubkeyHex, repoOwnerPubkey, context.repo);
  if (!isMaintainer) {
    return error(403, 'Only repository maintainers can delete files directly. Please submit a pull request instead.');
  }

  // Prepare signing options
  const signingOptions: {
    nip98Event?: NostrEvent;
    commitSignatureEvent?: NostrEvent;
  } = {};
  
  if (commitSignatureEvent && commitSignatureEvent.sig && commitSignatureEvent.id) {
    signingOptions.commitSignatureEvent = commitSignatureEvent;
  } else if (nip98Event) {
    signingOptions.nip98Event = nip98Event;
  }
  
  // Explicitly ignore nsecKey from client requests
  if (nsecKey) {
    const clientIp = event.request.headers.get('x-forwarded-for') || event.request.headers.get('x-real-ip') || 'unknown';
    logger.warn({ clientIp, npub: context.npub, repo: context.repo }, '[SECURITY] Client attempted to send nsecKey in request.');
    auditLogger.log({
      user: userPubkeyHex || undefined,
      ip: clientIp,
      action: 'auth_attempt',
      resource: 'file_operation',
      result: 'failure',
      error: 'Client attempted to send private key in request body',
      metadata: { reason: 'security_violation' }
    });
  }

  const clientIp = event.request.headers.get('x-forwarded-for') || event.request.headers.get('x-real-ip') || 'unknown';
  
  try {
    // Get default branch if not provided
    const targetBranch = branch || await fileManager.getDefaultBranch(context.npub, context.repo);
    
    await fileManager.deleteFile(
      context.npub,
      context.repo,
      filePath,
      commitMessage,
      finalAuthorName!,
      finalAuthorEmail!,
      targetBranch,
      Object.keys(signingOptions).length > 0 ? signingOptions : undefined
    );
    auditLogger.logFileOperation(
      userPubkeyHex,
      clientIp,
      'delete',
      `${context.npub}/${context.repo}`,
      filePath,
      'success'
    );
    return json({ success: true, message: 'File deleted and committed' });
  } catch (err) {
    auditLogger.logFileOperation(
      userPubkeyHex,
      clientIp,
      'delete',
      `${context.npub}/${context.repo}`,
      filePath,
      'failure',
      err instanceof Error ? err.message : String(err)
    );
    return handleApiError(err, { operation: 'deleteFile', npub: context.npub, repo: context.repo, filePath }, 'Failed to delete file');
  }
}
