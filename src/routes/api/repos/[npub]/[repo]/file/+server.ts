/**
 * API endpoint for reading and writing files in a repository
 */

import { json, error } from '@sveltejs/kit';
// @ts-ignore - SvelteKit generates this type
import type { RequestHandler } from './$types';
import { fileManager, repoManager, nostrClient } from '$lib/services/service-registry.js';
import { MaintainerService } from '$lib/services/nostr/maintainer-service.js';
import { DEFAULT_NOSTR_RELAYS } from '$lib/config.js';
import { nip19 } from 'nostr-tools';
import { verifyNIP98Auth } from '$lib/services/nostr/nip98-auth.js';
import { auditLogger } from '$lib/services/security/audit-logger.js';
import logger from '$lib/services/logger.js';
import type { NostrEvent } from '$lib/types/nostr.js';
import { requireNpubHex, decodeNpubToHex } from '$lib/utils/npub-utils.js';
import { handleApiError, handleValidationError, handleNotFoundError } from '$lib/utils/error-handler.js';
import { KIND } from '$lib/types/nostr.js';
import { join } from 'path';
import { existsSync } from 'fs';
import { repoCache, RepoCache } from '$lib/services/git/repo-cache.js';
import { extractRequestContext } from '$lib/utils/api-context.js';

const repoRoot = typeof process !== 'undefined' && process.env?.GIT_REPO_ROOT
  ? process.env.GIT_REPO_ROOT
  : '/repos';
const maintainerService = new MaintainerService(DEFAULT_NOSTR_RELAYS);

export const GET: RequestHandler = async (event) => {
  const { params, url, request } = event;
  const { npub, repo } = params;
  const filePath = url.searchParams.get('path');
  let ref = url.searchParams.get('ref') || 'HEAD';
  
  // Extract user pubkey using the same method as other endpoints
  const requestContext = extractRequestContext(event);
  const userPubkey = requestContext.userPubkey;
  const userPubkeyHex = requestContext.userPubkeyHex;
  
  // Debug logging for file endpoint
  logger.debug({ 
    hasUserPubkey: !!userPubkey, 
    hasUserPubkeyHex: !!userPubkeyHex,
    userPubkeyHex: userPubkeyHex ? userPubkeyHex.substring(0, 16) + '...' : null,
    npub, 
    repo, 
    filePath 
  }, 'File endpoint - extracted user context');

  if (!npub || !repo || !filePath) {
    return error(400, 'Missing npub, repo, or path parameter');
  }

  try {
    const repoPath = join(repoRoot, npub, `${repo}.git`);
    
    // If repo doesn't exist, try to fetch it on-demand
    if (!existsSync(repoPath)) {
      try {
        // Get repo owner pubkey
        let repoOwnerPubkey: string;
        try {
          repoOwnerPubkey = requireNpubHex(npub);
        } catch {
          return error(400, 'Invalid npub format');
        }

        // Fetch repository announcement from Nostr
        const events = await nostrClient.fetchEvents([
          {
            kinds: [KIND.REPO_ANNOUNCEMENT],
            authors: [repoOwnerPubkey],
            '#d': [repo],
            limit: 1
          }
        ]);

        if (events.length > 0) {
          // Try API-based fetching first (no cloning)
          try {
            const { tryApiFetchFile } = await import('$lib/utils/api-repo-helper.js');
            const fileContent = await tryApiFetchFile(events[0], npub, repo, filePath, ref);
            
            if (fileContent && fileContent.content) {
              return json(fileContent);
            }
          } catch (apiErr) {
            // Log the error but don't throw - we'll return a helpful error message below
            logger.debug({ error: apiErr, npub, repo, filePath, ref }, 'API file fetch failed, will return 404');
          }
          
          // API fetch failed - repo is not cloned and API fetch didn't work
          return error(404, 'Repository is not cloned locally and could not fetch file via API. Privileged users can clone this repository using the "Clone to Server" button.');
        } else {
          return error(404, 'Repository announcement not found in Nostr');
        }
      } catch (err) {
        logger.error({ error: err, npub, repo, filePath }, 'Error in on-demand file fetch');
        // Check if repo was created by another concurrent request
        if (existsSync(repoPath)) {
          // Repo exists now, clear cache and continue with normal flow
          repoCache.delete(RepoCache.repoExistsKey(npub, repo));
        } else {
          // If fetching fails, return 404
          return error(404, 'Repository not found');
        }
      }
    }

    // Double-check repo exists (should be true if we got here)
    if (!existsSync(repoPath)) {
      return error(404, 'Repository not found');
    }

    // Get repo owner pubkey for access check (already validated above if we did on-demand fetch)
    let repoOwnerPubkey: string;
    try {
      repoOwnerPubkey = requireNpubHex(npub);
    } catch {
      return error(400, 'Invalid npub format');
    }

    // If ref is a branch name, validate it exists or use default branch
    if (ref !== 'HEAD' && !ref.startsWith('refs/')) {
      try {
        const branches = await fileManager.getBranches(npub, repo);
        if (!branches.includes(ref)) {
          // Branch doesn't exist, try to get default branch
          try {
            ref = await fileManager.getDefaultBranch(npub, repo);
            logger.debug({ npub, repo, originalRef: url.searchParams.get('ref'), newRef: ref }, 'Branch not found, using default branch');
          } catch (defaultBranchErr) {
            // If we can't get default branch, fall back to HEAD
            logger.warn({ error: defaultBranchErr, npub, repo, ref }, 'Could not get default branch, falling back to HEAD');
            ref = 'HEAD';
          }
        }
      } catch (branchErr) {
        // If we can't get branches, fall back to HEAD
        logger.warn({ error: branchErr, npub, repo, ref }, 'Could not get branches, falling back to HEAD');
        ref = 'HEAD';
      }
    }

    // Check repository privacy (repoOwnerPubkey already declared above)
    logger.debug({ 
      userPubkeyHex: userPubkeyHex ? userPubkeyHex.substring(0, 16) + '...' : null,
      repoOwnerPubkey: repoOwnerPubkey.substring(0, 16) + '...',
      repo 
    }, 'File endpoint - checking canView before access check');
    
    const canView = await maintainerService.canView(userPubkeyHex || null, repoOwnerPubkey, repo);
    
    logger.debug({ 
      canView, 
      userPubkeyHex: userPubkeyHex ? userPubkeyHex.substring(0, 16) + '...' : null,
      repoOwnerPubkey: repoOwnerPubkey.substring(0, 16) + '...',
      repo 
    }, 'File endpoint - canView result');
    
    if (!canView) {
      auditLogger.logFileOperation(
        userPubkeyHex || null,
        requestContext.clientIp,
        'read',
        `${npub}/${repo}`,
        filePath,
        'denied',
        'Insufficient permissions'
      );
      return error(403, 'This repository is private. Only owners and maintainers can view it.');
    }
    try {
      // Log what we're trying to do
      logger.debug({ npub, repo, filePath, ref }, 'Attempting to read file from cloned repository');
      
      let fileContent;
      try {
        fileContent = await fileManager.getFileContent(npub, repo, filePath, ref);
      } catch (firstErr) {
        // If the first attempt fails and ref is not HEAD, try with HEAD as fallback
        if (ref !== 'HEAD' && !ref.startsWith('refs/')) {
          logger.warn({ 
            error: firstErr, 
            npub, 
            repo, 
            filePath, 
            originalRef: ref 
          }, 'Failed to read file with specified ref, trying HEAD as fallback');
          try {
            fileContent = await fileManager.getFileContent(npub, repo, filePath, 'HEAD');
            ref = 'HEAD'; // Update ref for logging
          } catch (headErr) {
            // If HEAD also fails, throw the original error
            throw firstErr;
          }
        } else {
          throw firstErr;
        }
      }
      
      auditLogger.logFileOperation(
        userPubkeyHex || null,
        requestContext.clientIp,
        'read',
        `${npub}/${repo}`,
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
        npub, 
        repo, 
        filePath, 
        ref,
        repoExists: existsSync(repoPath),
        errorMessage
      }, 'Error reading file from cloned repository');
      auditLogger.logFileOperation(
        userPubkeyHex || null,
        requestContext.clientIp,
        'read',
        `${npub}/${repo}`,
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
        return error(404, `File not found: ${filePath} at ref ${ref}`);
      }
      // For other errors, return 500 with a more helpful message
      return error(500, `Failed to read file: ${errorMessage}`);
    }
  } catch (err) {
    // This catch block handles errors that occur outside the file reading try-catch
    // (e.g., in branch validation, access checks, etc.)
    
    // If it's already a Response (from error handlers), return it
    if (err instanceof Response) {
      return err;
    }
    
    // If it's a SvelteKit HttpError (from error() function), re-throw it
    // SvelteKit errors have a status property and body property
    if (err && typeof err === 'object' && 'status' in err && 'body' in err) {
      throw err;
    }
    
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorStack = err instanceof Error ? err.stack : undefined;
    
    logger.error({ 
      error: err, 
      errorStack,
      npub, 
      repo, 
      filePath,
      ref: url.searchParams.get('ref'),
      errorMessage
    }, 'Unexpected error in file endpoint (outside file reading block)');
    
    // Check if it's a "not found" type error
    const errorLower = errorMessage.toLowerCase();
    if (errorLower.includes('not found') || 
        errorLower.includes('repository not found')) {
      return error(404, errorMessage);
    }
    
    return handleApiError(err, { operation: 'readFile', npub, repo, filePath }, 'Failed to read file');
  }
};

export const POST: RequestHandler = async ({ params, url, request }: { params: { npub?: string; repo?: string }; url: URL; request: Request }) => {
  const { npub, repo } = params;

  if (!npub || !repo) {
    return error(400, 'Missing npub or repo parameter');
  }

  let path: string | undefined;
  try {
    const body = await request.json();
    path = body.path;
    const { content, commitMessage, authorName, authorEmail, branch, action, userPubkey, useNIP07, nsecKey, commitSignatureEvent } = body;
    
    // Check for NIP-98 authentication (for git operations)
    const authHeader = request.headers.get('Authorization');
    let nip98Event = null;
    if (authHeader && authHeader.startsWith('Nostr ')) {
      const requestUrl = `${request.headers.get('x-forwarded-proto') || (url.protocol === 'https:' ? 'https' : 'http')}://${request.headers.get('host') || url.host}${url.pathname}${url.search}`;
      const authResult = verifyNIP98Auth(authHeader, requestUrl, request.method);
      if (authResult.valid && authResult.event) {
        nip98Event = authResult.event;
      }
    }

    if (!path || !commitMessage || !authorName || !authorEmail) {
      return error(400, 'Missing required fields: path, commitMessage, authorName, authorEmail');
    }

    if (!userPubkey) {
      return error(401, 'Authentication required. Please provide userPubkey.');
    }

    // Check if repo exists locally
    if (!fileManager.repoExists(npub, repo)) {
      // Try to fetch announcement to see if repo exists in Nostr
      let repoOwnerPubkey: string;
      try {
        repoOwnerPubkey = requireNpubHex(npub);
      } catch {
        return error(400, 'Invalid npub format');
      }

      // Fetch repository announcement from Nostr
      const events = await nostrClient.fetchEvents([
        {
          kinds: [KIND.REPO_ANNOUNCEMENT],
          authors: [repoOwnerPubkey],
          '#d': [repo],
          limit: 1
        }
      ]);

      if (events.length > 0) {
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
      repoOwnerPubkey = requireNpubHex(npub);
    } catch {
      return error(400, 'Invalid npub format');
    }

    // Convert userPubkey to hex if needed
    const userPubkeyHex = decodeNpubToHex(userPubkey) || userPubkey;

    const isMaintainer = await maintainerService.isMaintainer(userPubkeyHex, repoOwnerPubkey, repo);
    if (!isMaintainer) {
      return error(403, 'Only repository maintainers can edit files directly. Please submit a pull request instead.');
    }

    // Prepare signing options
    // NOTE: nsecKey is intentionally NOT supported from client requests for security reasons.
    // Clients should use NIP-07 (browser extension) or NIP-98 (HTTP auth) instead.
    // nsecKey is only for server-side use via environment variables.
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
    // Note: useNIP07 is no longer used since signing happens client-side
    // Explicitly ignore nsecKey from client requests - it's a security risk
    // Server-side signing should use NOSTRGIT_SECRET_KEY environment variable instead
    if (nsecKey) {
      // Security: Log warning but never log the actual key value
      const clientIp = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';
      logger.warn({ clientIp, npub, repo }, '[SECURITY] Client attempted to send nsecKey in request. This is not allowed for security reasons.');
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

    const clientIp = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';
    
    if (action === 'delete') {
      try {
        // Get default branch if not provided
        const targetBranch = branch || await fileManager.getDefaultBranch(npub, repo);
        
        await fileManager.deleteFile(
          npub,
          repo,
          path,
          commitMessage,
          authorName,
          authorEmail,
          targetBranch,
          Object.keys(signingOptions).length > 0 ? signingOptions : undefined
        );
        auditLogger.logFileOperation(
          userPubkeyHex,
          clientIp,
          'delete',
          `${npub}/${repo}`,
          path,
          'success'
        );
        return json({ success: true, message: 'File deleted and committed' });
      } catch (err) {
        auditLogger.logFileOperation(
          userPubkeyHex,
          clientIp,
          'delete',
          `${npub}/${repo}`,
          path,
          'failure',
          err instanceof Error ? err.message : String(err)
        );
        throw err;
      }
    } else if (action === 'create' || content !== undefined) {
      if (content === undefined) {
        return error(400, 'Content is required for create/update operations');
      }
      try {
        // Get default branch if not provided
        const targetBranch = branch || await fileManager.getDefaultBranch(npub, repo);
        
        await fileManager.writeFile(
          npub,
          repo,
          path,
          content,
          commitMessage,
          authorName,
          authorEmail,
          targetBranch,
          Object.keys(signingOptions).length > 0 ? signingOptions : undefined
        );
        auditLogger.logFileOperation(
          userPubkeyHex,
          clientIp,
          action === 'create' ? 'create' : 'write',
          `${npub}/${repo}`,
          path,
          'success'
        );
        return json({ success: true, message: 'File saved and committed' });
      } catch (err) {
        auditLogger.logFileOperation(
          userPubkeyHex,
          clientIp,
          action === 'create' ? 'create' : 'write',
          `${npub}/${repo}`,
          path,
          'failure',
          err instanceof Error ? err.message : String(err)
        );
        throw err;
      }
    } else {
      return error(400, 'Invalid action or missing content');
    }
  } catch (err) {
    return handleApiError(err, { operation: 'writeFile', npub, repo, filePath: path }, 'Failed to write file');
  }
};
