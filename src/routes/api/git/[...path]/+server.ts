/**
 * Git HTTP backend API route
 * Handles git clone, push, pull operations via git-http-backend
 */

import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { RepoManager } from '$lib/services/git/repo-manager.js';
import { nip19 } from 'nostr-tools';
import { requireNpubHex } from '$lib/utils/npub-utils.js';
import { spawn, execSync } from 'child_process';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { DEFAULT_NOSTR_RELAYS } from '$lib/config.js';
import { NostrClient } from '$lib/services/nostr/nostr-client.js';
import { KIND } from '$lib/types/nostr.js';
import type { NostrEvent } from '$lib/types/nostr.js';
import { verifyNIP98Auth } from '$lib/services/nostr/nip98-auth.js';
import { OwnershipTransferService } from '$lib/services/nostr/ownership-transfer-service.js';
import { MaintainerService } from '$lib/services/nostr/maintainer-service.js';
import { BranchProtectionService } from '$lib/services/nostr/branch-protection-service.js';
import logger from '$lib/services/logger.js';
import { auditLogger } from '$lib/services/security/audit-logger.js';

const repoRoot = process.env.GIT_REPO_ROOT || '/repos';
const repoManager = new RepoManager(repoRoot);
const nostrClient = new NostrClient(DEFAULT_NOSTR_RELAYS);
const ownershipTransferService = new OwnershipTransferService(DEFAULT_NOSTR_RELAYS);
const maintainerService = new MaintainerService(DEFAULT_NOSTR_RELAYS);
const branchProtectionService = new BranchProtectionService(DEFAULT_NOSTR_RELAYS);

// Path to git-http-backend (common locations)
// Alpine Linux: /usr/lib/git-core/git-http-backend
// Debian/Ubuntu: /usr/lib/git-core/git-http-backend
// macOS: /usr/local/libexec/git-core/git-http-backend or /opt/homebrew/libexec/git-core/git-http-backend
const GIT_HTTP_BACKEND_PATHS = [
  '/usr/lib/git-core/git-http-backend',  // Alpine, Debian, Ubuntu
  '/usr/libexec/git-core/git-http-backend',
  '/usr/local/libexec/git-core/git-http-backend',
  '/opt/homebrew/libexec/git-core/git-http-backend'
];

/**
 * Find git-http-backend executable
 */
function findGitHttpBackend(): string | null {
  for (const path of GIT_HTTP_BACKEND_PATHS) {
    if (existsSync(path)) {
      return path;
    }
  }
  // Try to find it via which/whereis
  try {
    const result = execSync('which git-http-backend 2>/dev/null || whereis -b git-http-backend 2>/dev/null', { encoding: 'utf-8' });
    const lines = result.trim().split(/\s+/);
    for (const line of lines) {
      if (line.includes('git-http-backend') && existsSync(line)) {
        return line;
      }
    }
  } catch {
    // Ignore errors
  }
  return null;
}


/**
 * Get repository announcement to extract clone URLs for post-receive sync
 */
async function getRepoAnnouncement(npub: string, repoName: string): Promise<NostrEvent | null> {
  try {
    const pubkey = requireNpubHex(npub);

    const events = await nostrClient.fetchEvents([
      {
        kinds: [KIND.REPO_ANNOUNCEMENT],
        authors: [pubkey],
        '#d': [repoName],
        limit: 1
      }
    ]);

    return events.length > 0 ? events[0] : null;
  } catch {
    return null;
  }
}

/**
 * Extract clone URLs from repository announcement
 */
function extractCloneUrls(event: NostrEvent): string[] {
  const urls: string[] = [];
  for (const tag of event.tags) {
    if (tag[0] === 'clone') {
      for (let i = 1; i < tag.length; i++) {
        const url = tag[i];
        if (url && typeof url === 'string') {
          urls.push(url);
        }
      }
    }
  }
  return urls;
}

export const GET: RequestHandler = async ({ params, url, request }) => {
  const path = params.path || '';
  
  // Parse path: {npub}/{repo-name}.git/{git-path}
  const match = path.match(/^([^\/]+)\/([^\/]+)\.git(?:\/(.+))?$/);
  if (!match) {
    return error(400, 'Invalid path format. Expected: {npub}/{repo-name}.git[/{git-path}]');
  }

  const [, npub, repoName, gitPath = ''] = match;
  const service = url.searchParams.get('service');

  // Build absolute request URL for NIP-98 validation
  const protocol = request.headers.get('x-forwarded-proto') || (url.protocol === 'https:' ? 'https' : 'http');
  const host = request.headers.get('host') || url.host;
  const requestUrl = `${protocol}://${host}${url.pathname}${url.search}`;

  // Validate npub format
  let pubkey: string;
  try {
    pubkey = requireNpubHex(npub);
  } catch {
    return error(400, 'Invalid npub format');
  }

  // Get repository path with security validation
  const repoPath = join(repoRoot, npub, `${repoName}.git`);
  // Security: Ensure the resolved path is within repoRoot to prevent path traversal
  const resolvedPath = resolve(repoPath);
  const resolvedRoot = resolve(repoRoot);
  if (!resolvedPath.startsWith(resolvedRoot + '/') && resolvedPath !== resolvedRoot) {
    return error(403, 'Invalid repository path');
  }
  if (!repoManager.repoExists(repoPath)) {
    return error(404, 'Repository not found');
  }

  // Check repository privacy for clone/fetch operations
  let originalOwnerPubkey: string;
  try {
    originalOwnerPubkey = requireNpubHex(npub);
  } catch {
    return error(400, 'Invalid npub format');
  }

  // For clone/fetch operations, check if repo is private
  // If private, require NIP-98 authentication
  const privacyInfo = await maintainerService.getPrivacyInfo(originalOwnerPubkey, repoName);
  if (privacyInfo.isPrivate) {
    // Private repos require authentication for clone/fetch
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Nostr ')) {
      return error(401, 'This repository is private. Authentication required.');
    }

    // Build absolute request URL for NIP-98 validation
    const protocol = request.headers.get('x-forwarded-proto') || (url.protocol === 'https:' ? 'https' : 'http');
    const host = request.headers.get('host') || url.host;
    const requestUrl = `${protocol}://${host}${url.pathname}${url.search}`;

    // Verify NIP-98 authentication
    const authResult = verifyNIP98Auth(
      authHeader,
      requestUrl,
      request.method,
      undefined // GET requests don't have body
    );

    if (!authResult.valid) {
      return error(401, authResult.error || 'Authentication required');
    }

    // Verify user can view the repo
    const canView = await maintainerService.canView(authResult.pubkey || null, originalOwnerPubkey, repoName);
    if (!canView) {
      const clientIp = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';
      auditLogger.logRepoAccess(
        authResult.pubkey || null,
        clientIp,
        'clone',
        `${npub}/${repoName}`,
        'denied',
        'Insufficient permissions'
      );
      return error(403, 'You do not have permission to access this private repository.');
    }
  }

  // Find git-http-backend
  const gitHttpBackend = findGitHttpBackend();
  if (!gitHttpBackend) {
    return error(500, 'git-http-backend not found. Please install git.');
  }

  // Build PATH_INFO
  // Security: Since we're setting GIT_PROJECT_ROOT to the specific repo path,
  // PATH_INFO should be relative to that repo (just the git operation path)
  // For info/refs: /info/refs
  // For other operations: /{git-path}
  const pathInfo = gitPath ? `/${gitPath}` : `/info/refs`;

  // Set up environment variables for git-http-backend
  // Security: Use the specific repository path, not the entire repoRoot
  // This limits git-http-backend's view to only this repository
  const envVars = {
    ...process.env,
    GIT_PROJECT_ROOT: resolve(repoPath), // Use specific repo path, not repoRoot
    GIT_HTTP_EXPORT_ALL: '1',
    REQUEST_METHOD: request.method,
    PATH_INFO: pathInfo,
    QUERY_STRING: url.searchParams.toString(),
    CONTENT_TYPE: request.headers.get('Content-Type') || '',
    CONTENT_LENGTH: request.headers.get('Content-Length') || '0',
    HTTP_USER_AGENT: request.headers.get('User-Agent') || '',
  };

  // Execute git-http-backend with timeout and security hardening
  const clientIp = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';
  const operation = service === 'git-upload-pack' || gitPath === 'git-upload-pack' ? 'fetch' : 'clone';

  return new Promise((resolve) => {
    // Security: Set timeout for git operations (5 minutes max)
    const timeoutMs = 5 * 60 * 1000;
    let timeoutId: NodeJS.Timeout;
    
    const gitProcess = spawn(gitHttpBackend, [], {
      env: envVars,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Security: Don't inherit parent's environment fully
      shell: false
    });

    timeoutId = setTimeout(() => {
      gitProcess.kill('SIGTERM');
      auditLogger.logRepoAccess(
        originalOwnerPubkey,
        clientIp,
        operation,
        `${npub}/${repoName}`,
        'failure',
        'Operation timeout'
      );
      resolve(error(504, 'Git operation timeout'));
    }, timeoutMs);

    const chunks: Buffer[] = [];
    let errorOutput = '';

    gitProcess.stdout.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    gitProcess.stderr.on('data', (chunk: Buffer) => {
      errorOutput += chunk.toString();
    });

    gitProcess.on('close', (code) => {
      clearTimeout(timeoutId);
      
      // Log audit entry after operation completes
      if (code === 0) {
        // Success: operation completed successfully
        auditLogger.logRepoAccess(
          originalOwnerPubkey,
          clientIp,
          operation,
          `${npub}/${repoName}`,
          'success'
        );
      } else {
        // Failure: operation failed
        auditLogger.logRepoAccess(
          originalOwnerPubkey,
          clientIp,
          operation,
          `${npub}/${repoName}`,
          'failure',
          errorOutput || 'Unknown error'
        );
      }
      
      if (code !== 0 && chunks.length === 0) {
        resolve(error(500, `git-http-backend error: ${errorOutput || 'Unknown error'}`));
        return;
      }

      const body = Buffer.concat(chunks);
      
      // Determine content type based on service
      let contentType = 'application/x-git-upload-pack-result';
      if (service === 'git-receive-pack' || gitPath === 'git-receive-pack') {
        contentType = 'application/x-git-receive-pack-result';
      } else if (service === 'git-upload-pack' || gitPath === 'git-upload-pack') {
        contentType = 'application/x-git-upload-pack-result';
      } else if (pathInfo.includes('info/refs')) {
        contentType = 'text/plain; charset=utf-8';
      }

      resolve(new Response(body, {
        status: code === 0 ? 200 : 500,
        headers: {
          'Content-Type': contentType,
          'Content-Length': body.length.toString(),
        }
      }));
    });

    gitProcess.on('error', (err) => {
      clearTimeout(timeoutId);
      // Log audit entry for process error
      auditLogger.logRepoAccess(
        originalOwnerPubkey,
        clientIp,
        operation,
        `${npub}/${repoName}`,
        'failure',
        `Process error: ${err.message}`
      );
      resolve(error(500, `Failed to execute git-http-backend: ${err.message}`));
    });
  });
};

export const POST: RequestHandler = async ({ params, url, request }) => {
  const path = params.path || '';
  
  // Parse path: {npub}/{repo-name}.git/{git-path}
  const match = path.match(/^([^\/]+)\/([^\/]+)\.git(?:\/(.+))?$/);
  if (!match) {
    return error(400, 'Invalid path format. Expected: {npub}/{repo-name}.git[/{git-path}]');
  }

  const [, npub, repoName, gitPath = ''] = match;

  // Validate npub format and decode to get pubkey
  let originalOwnerPubkey: string;
  try {
    originalOwnerPubkey = requireNpubHex(npub);
  } catch {
    return error(400, 'Invalid npub format');
  }

  // Get repository path with security validation
  const repoPath = join(repoRoot, npub, `${repoName}.git`);
  // Security: Ensure the resolved path is within repoRoot to prevent path traversal
  const resolvedPath = resolve(repoPath);
  const resolvedRoot = resolve(repoRoot);
  if (!resolvedPath.startsWith(resolvedRoot + '/') && resolvedPath !== resolvedRoot) {
    return error(403, 'Invalid repository path');
  }
  if (!repoManager.repoExists(repoPath)) {
    return error(404, 'Repository not found');
  }

  // Get current owner (may be different if ownership was transferred)
  const currentOwnerPubkey = await ownershipTransferService.getCurrentOwner(originalOwnerPubkey, repoName);

  // Build absolute request URL for NIP-98 validation
  const protocol = request.headers.get('x-forwarded-proto') || (url.protocol === 'https:' ? 'https' : 'http');
  const host = request.headers.get('host') || url.host;
  const requestUrl = `${protocol}://${host}${url.pathname}${url.search}`;

  // Get request body (read once, use for both auth and git-http-backend)
  const body = await request.arrayBuffer();
  const bodyBuffer = Buffer.from(body);

  // For push operations (git-receive-pack), require NIP-98 authentication
  if (gitPath === 'git-receive-pack' || path.includes('git-receive-pack')) {
    // Verify NIP-98 authentication
    const authResult = verifyNIP98Auth(
      request.headers.get('Authorization'),
      requestUrl,
      request.method,
      bodyBuffer.length > 0 ? bodyBuffer : undefined
    );

    if (!authResult.valid) {
      return error(401, authResult.error || 'Authentication required');
    }

    // Verify pubkey is current repo owner or maintainer
    const isMaintainer = await maintainerService.isMaintainer(
      authResult.pubkey || '',
      currentOwnerPubkey,
      repoName
    );
    
    if (authResult.pubkey !== currentOwnerPubkey && !isMaintainer) {
      return error(403, 'Event pubkey does not match repository owner or maintainer');
    }

    // Check branch protection rules
    // Note: We need to extract the target branch from the git push request
    // This is a simplified check - in production, you'd parse the git protocol
    // to determine the exact branch being pushed
    let targetBranch = 'main'; // Default to main if can't determine
    try {
      // Try to extract branch from request body (git protocol)
      const bodyText = bodyBuffer.toString('utf-8', 0, Math.min(bodyBuffer.length, 1000));
      const branchMatch = bodyText.match(/refs\/heads\/([^\s\n]+)/);
      targetBranch = branchMatch ? branchMatch[1] : 'main'; // Default to main if can't determine
      
      const protectionCheck = await branchProtectionService.canPushToBranch(
        authResult.pubkey || '',
        currentOwnerPubkey,
        repoName,
        targetBranch,
        isMaintainer
      );

      if (!protectionCheck.allowed) {
        return error(403, protectionCheck.reason || 'Branch is protected');
      }
    } catch (error) {
      // If we can't check protection, log but don't block (fail open for now)
      // Security: Sanitize error messages
      const sanitizedError = error instanceof Error ? error.message.replace(/nsec[0-9a-z]+/gi, '[REDACTED]').replace(/[0-9a-f]{64}/g, '[REDACTED]') : String(error);
      logger.warn({ error: sanitizedError, npub, repoName, targetBranch }, 'Failed to check branch protection');
    }
  }

  // Find git-http-backend
  const gitHttpBackend = findGitHttpBackend();
  if (!gitHttpBackend) {
    return error(500, 'git-http-backend not found. Please install git.');
  }

  // Build PATH_INFO
  // Security: Since we're setting GIT_PROJECT_ROOT to the specific repo path,
  // PATH_INFO should be relative to that repo (just the git operation path)
  const pathInfo = gitPath ? `/${gitPath}` : `/`;

  // Set up environment variables for git-http-backend
  // Security: Use the specific repository path, not the entire repoRoot
  // This limits git-http-backend's view to only this repository
  const envVars = {
    ...process.env,
    GIT_PROJECT_ROOT: resolve(repoPath), // Use specific repo path, not repoRoot
    GIT_HTTP_EXPORT_ALL: '1',
    REQUEST_METHOD: request.method,
    PATH_INFO: pathInfo,
    QUERY_STRING: url.searchParams.toString(),
    CONTENT_TYPE: request.headers.get('Content-Type') || 'application/x-git-receive-pack-request',
    CONTENT_LENGTH: bodyBuffer.length.toString(),
    HTTP_USER_AGENT: request.headers.get('User-Agent') || '',
  };

  // Execute git-http-backend with timeout and security hardening
  const clientIp = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';
  const operation = gitPath === 'git-receive-pack' || path.includes('git-receive-pack') ? 'push' : 'fetch';

  return new Promise((resolve) => {
    // Security: Set timeout for git operations (5 minutes max)
    const timeoutMs = 5 * 60 * 1000;
    let timeoutId: NodeJS.Timeout;
    
    const gitProcess = spawn(gitHttpBackend, [], {
      env: envVars,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Security: Don't inherit parent's environment fully
      shell: false
    });

    timeoutId = setTimeout(() => {
      gitProcess.kill('SIGTERM');
      auditLogger.logRepoAccess(
        currentOwnerPubkey,
        clientIp,
        operation,
        `${npub}/${repoName}`,
        'failure',
        'Operation timeout'
      );
      resolve(error(504, 'Git operation timeout'));
    }, timeoutMs);

    const chunks: Buffer[] = [];
    let errorOutput = '';

    // Write request body to git-http-backend stdin
    gitProcess.stdin.write(bodyBuffer);
    gitProcess.stdin.end();

    gitProcess.stdout.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    gitProcess.stderr.on('data', (chunk: Buffer) => {
      errorOutput += chunk.toString();
    });

    gitProcess.on('close', async (code) => {
      clearTimeout(timeoutId);
      
      // Log audit entry after operation completes
      if (code === 0) {
        // Success: operation completed successfully
        auditLogger.logRepoAccess(
          currentOwnerPubkey,
          clientIp,
          operation,
          `${npub}/${repoName}`,
          'success'
        );
      } else {
        // Failure: operation failed
        auditLogger.logRepoAccess(
          currentOwnerPubkey,
          clientIp,
          operation,
          `${npub}/${repoName}`,
          'failure',
          errorOutput || 'Git operation failed'
        );
      }
      
      // If this was a successful push, sync to other remotes
      if (code === 0 && (gitPath === 'git-receive-pack' || path.includes('git-receive-pack'))) {
        try {
          const announcement = await getRepoAnnouncement(npub, repoName);
          if (announcement) {
            const cloneUrls = extractCloneUrls(announcement);
            const gitDomain = process.env.GIT_DOMAIN || 'localhost:6543';
            const otherUrls = cloneUrls.filter(url => !url.includes(gitDomain));
            if (otherUrls.length > 0) {
              // Sync in background (don't wait for it)
              repoManager.syncToRemotes(repoPath, otherUrls).catch(err => {
                // Security: Sanitize error messages
                const sanitizedErr = err instanceof Error ? err.message.replace(/nsec[0-9a-z]+/gi, '[REDACTED]').replace(/[0-9a-f]{64}/g, '[REDACTED]') : String(err);
                logger.error({ error: sanitizedErr, npub, repoName }, 'Failed to sync to remotes after push');
              });
            }
          }
        } catch (err) {
          // Security: Sanitize error messages
          const sanitizedErr = err instanceof Error ? err.message.replace(/nsec[0-9a-z]+/gi, '[REDACTED]').replace(/[0-9a-f]{64}/g, '[REDACTED]') : String(err);
          logger.error({ error: sanitizedErr, npub, repoName }, 'Failed to sync to remotes');
          // Don't fail the request if sync fails
        }
      }

      if (code !== 0 && chunks.length === 0) {
        resolve(error(500, `git-http-backend error: ${errorOutput || 'Unknown error'}`));
        return;
      }

      const responseBody = Buffer.concat(chunks);
      
      // Determine content type
      let contentType = 'application/x-git-receive-pack-result';
      if (gitPath === 'git-upload-pack' || path.includes('git-upload-pack')) {
        contentType = 'application/x-git-upload-pack-result';
      }

      resolve(new Response(responseBody, {
        status: code === 0 ? 200 : 500,
        headers: {
          'Content-Type': contentType,
          'Content-Length': responseBody.length.toString(),
        }
      }));
    });

    gitProcess.on('error', (err) => {
      clearTimeout(timeoutId);
      // Log audit entry for process error
      auditLogger.logRepoAccess(
        currentOwnerPubkey,
        clientIp,
        operation,
        `${npub}/${repoName}`,
        'failure',
        `Process error: ${err.message}`
      );
      resolve(error(500, `Failed to execute git-http-backend: ${err.message}`));
    });
  });
};
