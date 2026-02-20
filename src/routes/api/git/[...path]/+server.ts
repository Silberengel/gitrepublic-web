/**
 * Git HTTP backend API route
 * Handles git clone, push, pull operations via git-http-backend
 */

import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { RepoManager } from '$lib/services/git/repo-manager.js';
import { requireNpubHex } from '$lib/utils/npub-utils.js';
import { spawn } from 'child_process';
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
import { isValidBranchName, sanitizeError } from '$lib/utils/security.js';
import { extractCloneUrls } from '$lib/utils/nostr-utils.js';

// Resolve GIT_REPO_ROOT to absolute path (handles both relative and absolute paths)
const repoRootEnv = process.env.GIT_REPO_ROOT || '/repos';
const repoRoot = resolve(repoRootEnv);
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
 * Security: Uses spawn instead of execSync to prevent command injection
 */
async function findGitHttpBackend(): Promise<string | null> {
  for (const path of GIT_HTTP_BACKEND_PATHS) {
    if (existsSync(path)) {
      return path;
    }
  }
  // Try to find it via which/whereis using spawn (safer than execSync)
  try {
    // Try 'which' first
    try {
      const whichResult = await new Promise<string>((resolve, reject) => {
        const proc = spawn('which', ['git-http-backend'], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
        proc.on('close', (code) => {
          if (code === 0 && stdout.trim()) {
            resolve(stdout.trim());
          } else {
            reject(new Error('not found'));
          }
        });
        proc.on('error', reject);
      });
      if (whichResult && existsSync(whichResult)) {
        return whichResult;
      }
    } catch {
      // Try 'whereis' as fallback
      try {
        const whereisResult = await new Promise<string>((resolve, reject) => {
          const proc = spawn('whereis', ['-b', 'git-http-backend'], { stdio: ['ignore', 'pipe', 'pipe'] });
          let stdout = '';
          proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
          proc.on('close', (code) => {
            if (code === 0 && stdout.trim()) {
              resolve(stdout.trim());
            } else {
              reject(new Error('not found'));
            }
          });
          proc.on('error', reject);
        });
        const lines = whereisResult.trim().split(/\s+/);
        for (const line of lines) {
          if (line.includes('git-http-backend') && existsSync(line)) {
            return line;
          }
        }
      } catch {
        // Ignore errors
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

// Note: Using shared extractCloneUrls utility (without normalization for performance)

/**
 * Normalize Authorization header from git credential helper format
 * Git credential helper outputs username=nostr and password=<base64-event>
 * Git HTTP backend converts this to Authorization: Basic <base64(username:password)>
 * This function converts it back to Authorization: Nostr <base64-event> format
 */
function normalizeAuthHeader(authHeader: string | null): string | null {
  if (!authHeader) {
    return null;
  }

  // If already in Nostr format, return as-is
  if (authHeader.startsWith('Nostr ')) {
    return authHeader;
  }

  // If it's Basic auth, try to extract the NIP-98 event
  if (authHeader.startsWith('Basic ')) {
    try {
      const base64Credentials = authHeader.slice(6); // Remove "Basic " prefix
      const credentials = Buffer.from(base64Credentials, 'base64').toString('utf-8');
      const [username, ...passwordParts] = credentials.split(':');
      const password = passwordParts.join(':'); // Rejoin in case password contains colons
      
      // If username is "nostr", the password is the base64-encoded NIP-98 event
      if (username === 'nostr' && password) {
        // Trim whitespace and control characters that might be added during encoding
        const trimmedPassword = password.trim().replace(/[\r\n\t\0]/g, '');
        
        // Validate the password is valid base64-encoded JSON before using it
        try {
          const testDecode = Buffer.from(trimmedPassword, 'base64').toString('utf-8');
          JSON.parse(testDecode); // Verify it's valid JSON
          return `Nostr ${trimmedPassword}`;
        } catch (err) {
          logger.warn({ error: err instanceof Error ? err.message : String(err) }, 
            'Invalid base64-encoded NIP-98 event in Basic auth password');
          return authHeader; // Return original header if invalid
        }
      }
    } catch (err) {
      // If decoding fails, return original header
      logger.debug({ error: err }, 'Failed to decode Basic auth header');
    }
  }

  // Return original header if we can't convert it
  return authHeader;
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
  // Normalize paths to handle Windows/Unix differences
  const resolvedPath = resolve(repoPath).replace(/\\/g, '/');
  const resolvedRoot = resolve(repoRoot).replace(/\\/g, '/');
  // Must be a subdirectory of repoRoot, not equal to it
  if (!resolvedPath.startsWith(resolvedRoot + '/')) {
    return error(403, 'Invalid repository path');
  }
  if (!repoManager.repoExists(repoPath)) {
    logger.warn({ repoPath, resolvedPath, repoRoot, resolvedRoot }, 'Repository not found at expected path');
    return error(404, `Repository not found at ${resolvedPath}. Please check GIT_REPO_ROOT environment variable (currently: ${repoRoot})`);
  }
  
  // Verify it's a valid git repository
  const gitDir = join(resolvedPath, 'objects');
  if (!existsSync(gitDir)) {
    logger.warn({ repoPath: resolvedPath }, 'Repository path exists but is not a valid git repository');
    return error(500, `Repository at ${resolvedPath} is not a valid git repository`);
  }
  
  // Ensure http.receivepack is enabled for push operations
  // This is required for git-http-backend to allow receive-pack service
  // Even with GIT_HTTP_EXPORT_ALL=1, the repository config must allow it
  if (service === 'git-receive-pack') {
    try {
      // Security: Use spawnSync with argument arrays instead of execSync
      const { spawnSync } = await import('child_process');
      // Set http.receivepack to true if not already set
      spawnSync('git', ['config', 'http.receivepack', 'true'], { 
        cwd: resolvedPath,
        stdio: 'ignore',
        timeout: 5000
      });
      logger.debug({ repoPath: resolvedPath }, 'Enabled http.receivepack for repository');
    } catch (err) {
      // Log but don't fail - git-http-backend might still work
      logger.debug({ error: err, repoPath: resolvedPath }, 'Failed to set http.receivepack (may already be set)');
    }
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
    const rawAuthHeader = request.headers.get('Authorization');
    // Normalize auth header (convert Basic auth from git credential helper to Nostr format)
    const authHeader = normalizeAuthHeader(rawAuthHeader);
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
  const gitHttpBackend = await findGitHttpBackend();
  if (!gitHttpBackend) {
    return error(500, 'git-http-backend not found. Please install git.');
  }

  // Build PATH_INFO using repository-per-directory mode
  // GIT_PROJECT_ROOT points to the parent directory containing repositories
  // PATH_INFO includes the repository name: /repo.git/info/refs
  const repoParentDir = resolve(join(repoRoot, npub));
  const repoRelativePath = `${repoName}.git`;
  const gitOperationPath = gitPath ? `/${gitPath}` : `/info/refs`;
  const pathInfo = `/${repoRelativePath}${gitOperationPath}`;
  
  // Debug logging for git operations
  logger.debug({ 
    npub, 
    repoName, 
    resolvedPath,
    repoParentDir,
    repoRelativePath,
    pathInfo, 
    service, 
    gitHttpBackend,
    method: request.method 
  }, 'Processing git HTTP request');

  // Set up environment variables for git-http-backend
  // Security: Whitelist only necessary environment variables
  // This prevents leaking secrets from process.env
  const envVars: Record<string, string> = {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: process.env.HOME || '/tmp',
    USER: process.env.USER || 'git',
    LANG: process.env.LANG || 'C.UTF-8',
    LC_ALL: process.env.LC_ALL || 'C.UTF-8',
    GIT_PROJECT_ROOT: repoParentDir, // Parent directory containing repositories
    GIT_HTTP_EXPORT_ALL: '1',
    REQUEST_METHOD: request.method,
    PATH_INFO: pathInfo,
    QUERY_STRING: url.searchParams.toString(),
    CONTENT_TYPE: request.headers.get('Content-Type') || '',
    CONTENT_LENGTH: request.headers.get('Content-Length') || '0',
    HTTP_USER_AGENT: request.headers.get('User-Agent') || '',
  };
  
  // Debug: Log environment variables (sanitized)
  logger.debug({ 
    GIT_PROJECT_ROOT: repoParentDir,
    PATH_INFO: pathInfo,
    QUERY_STRING: url.searchParams.toString(),
    REQUEST_METHOD: request.method
  }, 'git-http-backend environment');
  
  // Add TZ if set (for consistent timestamps)
  if (process.env.TZ) {
    envVars.TZ = process.env.TZ;
  }

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
      // Force kill after grace period if process doesn't terminate
      const forceKillTimeout = setTimeout(() => {
        if (!gitProcess.killed) {
          gitProcess.kill('SIGKILL');
        }
      }, 5000); // 5 second grace period
      
      // Clear force kill timeout if process terminates
      gitProcess.on('close', () => {
        clearTimeout(forceKillTimeout);
      });
      
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
      
      // Debug: Log git-http-backend output
      let body = Buffer.concat(chunks);
      logger.debug({ 
        code, 
        bodyLength: body.length, 
        bodyPreview: body.slice(0, 200).toString('utf-8'),
        errorOutput: errorOutput.slice(0, 500),
        pathInfo,
        service
      }, 'git-http-backend response');
      
      if (code !== 0 && chunks.length === 0) {
        const sanitizedError = sanitizeError(errorOutput || 'Unknown error');
        resolve(error(500, `git-http-backend error: ${sanitizedError}`));
        return;
      }
      
      // For info/refs requests, git-http-backend includes HTTP headers in the body
      // We need to strip them and only send the git protocol data
      // The format is: HTTP headers + blank line (\r\n\r\n or \n\n) + git protocol data
      // Also check for headers in POST responses (some git-http-backend versions include them)
      const bodyStr = body.toString('binary');
      const hasHttpHeaders = bodyStr.match(/^(Expires|Content-Type|Cache-Control|Pragma):/i);
      
      if (hasHttpHeaders || pathInfo.includes('info/refs')) {
        // Try to find header end with \r\n\r\n first (standard HTTP)
        let headerEnd = bodyStr.indexOf('\r\n\r\n');
        if (headerEnd === -1) {
          // Fallback to \n\n (some systems use just \n)
          headerEnd = bodyStr.indexOf('\n\n');
          if (headerEnd !== -1) {
            // Extract only the git protocol data (after the blank line)
            body = Buffer.from(bodyStr.slice(headerEnd + 2), 'binary');
          }
        } else {
          // Extract only the git protocol data (after the blank line)
          body = Buffer.from(bodyStr.slice(headerEnd + 4), 'binary');
        }
        
        // Additional safety: ensure body starts with git protocol format
        // Git protocol should start with a length prefix (hex) or service line
        const bodyStart = body.toString('utf-8', 0, Math.min(100, body.length));
        if (headerEnd !== -1 && !bodyStart.match(/^[0-9a-f]{4}|^# service=/i)) {
          logger.warn({ 
            bodyStart: bodyStart.substring(0, 50),
            headerEnd,
            pathInfo
          }, 'Warning: Stripped headers but body does not start with git protocol format');
        }
        
        logger.debug({ 
          originalLength: Buffer.concat(chunks).length,
          protocolDataLength: body.length,
          headerEnd,
          bodyStart: bodyStart.substring(0, 50),
          pathInfo,
          hasHttpHeaders: !!hasHttpHeaders
        }, 'Stripped HTTP headers from git-http-backend response');
      }
      
      // Determine content type based on request type
      // For info/refs requests with service parameter, use the appropriate advertisement content type
      let contentType = 'text/plain; charset=utf-8';
      if (pathInfo.includes('info/refs')) {
        if (service === 'git-receive-pack') {
          // info/refs?service=git-receive-pack returns application/x-git-receive-pack-advertisement
          contentType = 'application/x-git-receive-pack-advertisement';
        } else if (service === 'git-upload-pack') {
          // info/refs?service=git-upload-pack returns application/x-git-upload-pack-advertisement
          contentType = 'application/x-git-upload-pack-advertisement';
        } else {
          // info/refs without service parameter is text/plain
          contentType = 'text/plain; charset=utf-8';
        }
      } else if (service === 'git-receive-pack' || gitPath === 'git-receive-pack') {
        // POST requests to git-receive-pack (push)
        contentType = 'application/x-git-receive-pack-result';
      } else if (service === 'git-upload-pack' || gitPath === 'git-upload-pack') {
        // POST requests to git-upload-pack (fetch)
        contentType = 'application/x-git-upload-pack-result';
      }

      // Debug: Log response details
      logger.debug({ 
        status: code === 0 ? 200 : 500,
        contentType,
        bodyLength: body.length,
        bodyHex: body.slice(0, 100).toString('hex'),
        headers: {
          'Content-Type': contentType,
          'Content-Length': body.length.toString(),
        }
      }, 'Sending git HTTP response');
      
      // Build response headers
      // Git expects specific headers for info/refs responses
      const headers: HeadersInit = {
        'Content-Type': contentType,
        'Content-Length': body.length.toString(),
      };
      
      // For info/refs with service parameter, add Cache-Control header
      if (pathInfo.includes('info/refs') && service) {
        headers['Cache-Control'] = 'no-cache';
      }
      
      // Debug: Log response details
      logger.debug({ 
        status: code === 0 ? 200 : 500,
        contentType,
        bodyLength: body.length,
        bodyPreview: body.slice(0, 200).toString('utf-8'),
        headers
      }, 'Sending git HTTP response');
      
      resolve(new Response(body, {
        status: code === 0 ? 200 : 500,
        headers
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
      const sanitizedError = sanitizeError(err);
      resolve(error(500, `Failed to execute git-http-backend: ${sanitizedError}`));
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
  // Normalize paths to handle Windows/Unix differences
  const resolvedPath = resolve(repoPath).replace(/\\/g, '/');
  const resolvedRoot = resolve(repoRoot).replace(/\\/g, '/');
  // Must be a subdirectory of repoRoot, not equal to it
  if (!resolvedPath.startsWith(resolvedRoot + '/')) {
    return error(403, 'Invalid repository path');
  }
  if (!repoManager.repoExists(repoPath)) {
    logger.warn({ repoPath, resolvedPath, repoRoot, resolvedRoot }, 'Repository not found at expected path');
    return error(404, `Repository not found at ${resolvedPath}. Please check GIT_REPO_ROOT environment variable (currently: ${repoRoot})`);
  }
  
  // Verify it's a valid git repository
  const gitDir = join(resolvedPath, 'objects');
  if (!existsSync(gitDir)) {
    logger.warn({ repoPath: resolvedPath }, 'Repository path exists but is not a valid git repository');
    return error(500, `Repository at ${resolvedPath} is not a valid git repository`);
  }
  
  // Ensure http.receivepack is enabled for push operations
  // This is required for git-http-backend to allow receive-pack service
  // Even with GIT_HTTP_EXPORT_ALL=1, the repository config must allow it
  if (gitPath === 'git-receive-pack' || path.includes('git-receive-pack')) {
    try {
      // Security: Use spawnSync with argument arrays instead of execSync
      const { spawnSync } = await import('child_process');
      // Set http.receivepack to true if not already set
      spawnSync('git', ['config', 'http.receivepack', 'true'], { 
        cwd: resolvedPath,
        stdio: 'ignore',
        timeout: 5000
      });
      logger.debug({ repoPath: resolvedPath }, 'Enabled http.receivepack for repository');
    } catch (err) {
      // Log but don't fail - git-http-backend might still work
      logger.debug({ error: err, repoPath: resolvedPath }, 'Failed to set http.receivepack (may already be set)');
    }
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
    const rawAuthHeader = request.headers.get('Authorization');
    
    // Always return 401 with WWW-Authenticate if no Authorization header
    // This ensures git calls the credential helper proactively
    // Git requires WWW-Authenticate header on ALL 401 responses, otherwise it won't retry
    if (!rawAuthHeader) {
      return new Response('Authentication required. Please configure the git credential helper. Install via: npm install -g gitrepublic-cli\nSee https://github.com/silberengel/gitrepublic-cli for setup instructions.', {
        status: 401,
        headers: {
          'WWW-Authenticate': 'Basic realm="GitRepublic"',
          'Content-Type': 'text/plain'
        }
      });
    }
    
    // Normalize auth header (convert Basic auth from git credential helper to Nostr format)
    const authHeader = normalizeAuthHeader(rawAuthHeader);
    
    // Verify NIP-98 authentication
    const authResult = verifyNIP98Auth(
      authHeader,
      requestUrl,
      request.method,
      bodyBuffer.length > 0 ? bodyBuffer : undefined
    );

    if (!authResult.valid) {
      logger.warn({ 
        error: authResult.error,
        requestUrl,
        requestMethod: request.method
      }, 'NIP-98 authentication failed for push');
      
      // Always return 401 with WWW-Authenticate header, even if Authorization was present
      // This ensures git retries with the credential helper
      // Git requires WWW-Authenticate on ALL 401 responses, otherwise it won't retry
      const errorMessage = authResult.error || 'Authentication required';
      
      return new Response(errorMessage, {
        status: 401,
        headers: {
          'WWW-Authenticate': 'Basic realm="GitRepublic"',
          'Content-Type': 'text/plain'
        }
      });
    }
    
    logger.debug({ 
      pubkey: authResult.pubkey,
      requestUrl,
      requestMethod: request.method
    }, 'NIP-98 authentication successful for push');

    // Verify pubkey is current repo owner or maintainer
    const isMaintainer = await maintainerService.isMaintainer(
      authResult.pubkey || '',
      currentOwnerPubkey,
      repoName
    );
    
    if (authResult.pubkey !== currentOwnerPubkey && !isMaintainer) {
      const clientIp = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';
      const authPubkey = authResult.pubkey || '';
      
      logger.warn({ 
        authPubkey,
        currentOwnerPubkey,
        isMaintainer,
        repoName: `${npub}/${repoName}`
      }, 'Push denied: insufficient permissions');
      
      auditLogger.logRepoAccess(
        authPubkey,
        clientIp,
        'push',
        `${npub}/${repoName}`,
        'denied',
        'Not repository owner or maintainer'
      );
      
      // Get list of maintainers for the error message
      const { maintainers } = await maintainerService.getMaintainers(currentOwnerPubkey, repoName);
      const maintainerList = maintainers
        .filter(m => m !== currentOwnerPubkey) // Exclude owner from maintainer list
        .map(m => m.substring(0, 16) + '...')
        .join(', ');
      
      // Return user-friendly error message as plain text
      // Note: Git doesn't display response bodies for 403 errors, but the message is here
      // for debugging and for tools that do read response bodies (like curl)
      let errorMessage = `Permission denied: You are not the repository owner or a maintainer.\n` +
        `Repository: ${npub}/${repoName}\n` +
        `Your pubkey: ${authPubkey.substring(0, 16)}...\n` +
        `Owner pubkey: ${currentOwnerPubkey.substring(0, 16)}...\n`;
      
      if (maintainerList) {
        errorMessage += `Maintainers: ${maintainerList}\n`;
      } else {
        errorMessage += `Maintainers: (none - only owner can push)\n`;
      }
      
      errorMessage += `\nTo push, use the private key (nsec) that matches the repository owner, or be added as a maintainer.\n` +
        `Set NOSTRGIT_SECRET_KEY to the correct private key.\n` +
        `\nNote: Use 'gitrepublic-push' instead of 'git push' to see this detailed error message.`;
      
      // Return plain text response so git can display it
      // Git will show this in the terminal when verbose mode is enabled
      return new Response(errorMessage, {
        status: 403,
        statusText: 'Forbidden',
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Length': Buffer.byteLength(errorMessage, 'utf-8').toString()
        }
      });
    }

    // Check branch protection rules
    // Parse git push protocol to extract branch names being pushed
    // Git receive-pack protocol format:
    // - Capability lines (optional)
    // - Ref updates: <old-sha> <new-sha> refs/heads/<branch>\0<capabilities>
    // - Pack data follows (binary)
    const pushedBranches: string[] = [];
    try {
      // Parse git receive-pack protocol
      // The protocol uses null-terminated strings and space-separated refs
      // Format: <old-sha> <new-sha> refs/heads/<branch-name>\0[capabilities]
      const bodyText = bodyBuffer.toString('binary');
      
      // Split by null bytes to separate ref updates from pack data
      const nullIndex = bodyText.indexOf('\0');
      const refSection = nullIndex >= 0 ? bodyText.substring(0, nullIndex) : bodyText;
      
      // Split ref section by newlines (each line is a ref update)
      const refLines = refSection.split('\n').filter(line => line.trim().length > 0);
      
      for (const line of refLines) {
        // Parse format: <old-sha> <new-sha> refs/heads/<branch-name>
        // Or: <old-sha> <new-sha> refs/heads/<branch-name>\0<capabilities>
        const parts = line.split(/\s+/);
        if (parts.length >= 3) {
          const refPath = parts[2];
          // Extract branch name from refs/heads/<branch>
          if (refPath.startsWith('refs/heads/')) {
            const branchName = refPath.substring(11); // Remove 'refs/heads/' prefix
            // Remove any null bytes or capabilities that might be appended
            const cleanBranchName = branchName.split('\0')[0].trim();
            
            // Validate branch name
            if (cleanBranchName && isValidBranchName(cleanBranchName)) {
              pushedBranches.push(cleanBranchName);
            }
          }
        }
      }
      
      // If no branches found, try fallback regex (for edge cases)
      if (pushedBranches.length === 0) {
        const fallbackMatch = bodyText.match(/refs\/heads\/([^\s\n\0]+)/);
        if (fallbackMatch && isValidBranchName(fallbackMatch[1])) {
          pushedBranches.push(fallbackMatch[1]);
        }
      }
      
      // Default to 'main' if we can't determine any branch (shouldn't happen in normal operation)
      if (pushedBranches.length === 0) {
        logger.warn({ repoName, bodyLength: bodyBuffer.length }, 'Could not extract branch name from git push, defaulting to main');
        pushedBranches.push('main');
      }
      
      // Check protection for all branches being pushed
      for (const targetBranch of pushedBranches) {
        try {
          const protectionCheck = await branchProtectionService.canPushToBranch(
            authResult.pubkey || '',
            currentOwnerPubkey,
            repoName,
            targetBranch,
            isMaintainer
          );

          if (!protectionCheck.allowed) {
            return error(403, protectionCheck.reason || `Branch '${targetBranch}' is protected`);
          }
        } catch (error) {
          // If we can't check protection, log but don't block (fail open for now)
          // Security: Sanitize error messages
          const sanitizedError = sanitizeError(error);
          logger.warn({ error: sanitizedError, npub, repoName, targetBranch }, 'Failed to check branch protection');
        }
      }
    } catch (error) {
      // If we can't extract branches or check protection, log but don't block (fail open for now)
      // Security: Sanitize error messages
      const sanitizedError = sanitizeError(error);
      logger.warn({ error: sanitizedError, npub, repoName }, 'Failed to check branch protection');
    }
  }

  // Find git-http-backend
  const gitHttpBackend = await findGitHttpBackend();
  if (!gitHttpBackend) {
    return error(500, 'git-http-backend not found. Please install git.');
  }

  // Build PATH_INFO using repository-per-directory mode (same as GET handler)
  const repoParentDir = resolve(join(repoRoot, npub));
  const repoRelativePath = `${repoName}.git`;
  const gitOperationPath = gitPath ? `/${gitPath}` : `/`;
  const pathInfo = `/${repoRelativePath}${gitOperationPath}`;

  // Set up environment variables for git-http-backend
  // Security: Whitelist only necessary environment variables
  // This prevents leaking secrets from process.env
  const envVars: Record<string, string> = {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: process.env.HOME || '/tmp',
    USER: process.env.USER || 'git',
    LANG: process.env.LANG || 'C.UTF-8',
    LC_ALL: process.env.LC_ALL || 'C.UTF-8',
    GIT_PROJECT_ROOT: repoParentDir, // Parent directory containing repositories
    GIT_HTTP_EXPORT_ALL: '1',
    REQUEST_METHOD: request.method,
    PATH_INFO: pathInfo,
    QUERY_STRING: url.searchParams.toString(),
    CONTENT_TYPE: request.headers.get('Content-Type') || 'application/x-git-receive-pack-request',
    CONTENT_LENGTH: bodyBuffer.length.toString(),
    HTTP_USER_AGENT: request.headers.get('User-Agent') || '',
  };
  
  // Pass Authorization header to git-http-backend (if present)
  // Git-http-backend uses HTTP_AUTHORIZATION environment variable
  const authHeader = request.headers.get('Authorization');
  if (authHeader) {
    envVars.HTTP_AUTHORIZATION = authHeader;
  }
  
  // Debug: Log environment variables (sanitized)
  logger.debug({ 
    GIT_PROJECT_ROOT: repoParentDir,
    PATH_INFO: pathInfo,
    QUERY_STRING: url.searchParams.toString(),
    REQUEST_METHOD: request.method
  }, 'git-http-backend environment (POST)');
  
  // Add TZ if set (for consistent timestamps)
  if (process.env.TZ) {
    envVars.TZ = process.env.TZ;
  }

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
      // Force kill after grace period if process doesn't terminate
      const forceKillTimeout = setTimeout(() => {
        if (!gitProcess.killed) {
          gitProcess.kill('SIGKILL');
        }
      }, 5000); // 5 second grace period
      
      // Clear force kill timeout if process terminates
      gitProcess.on('close', () => {
        clearTimeout(forceKillTimeout);
      });
      
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
          const sanitizedErr = sanitizeError(err);
          logger.error({ error: sanitizedErr, npub, repoName }, 'Failed to sync to remotes');
          // Don't fail the request if sync fails
        }
      }

      if (code !== 0 && chunks.length === 0) {
        const sanitizedError = sanitizeError(errorOutput || 'Unknown error');
        resolve(error(500, `git-http-backend error: ${sanitizedError}`));
        return;
      }

      let responseBody = Buffer.concat(chunks);
      
      // Check if git-http-backend included HTTP headers in POST response body
      // Some versions include headers that need to be stripped
      const bodyStr = responseBody.toString('binary');
      const hasHttpHeaders = bodyStr.match(/^(Expires|Content-Type|Cache-Control|Pragma):/i);
      
      if (hasHttpHeaders) {
        // Try to find header end with \r\n\r\n first (standard HTTP)
        let headerEnd = bodyStr.indexOf('\r\n\r\n');
        if (headerEnd === -1) {
          // Fallback to \n\n (some systems use just \n)
          headerEnd = bodyStr.indexOf('\n\n');
          if (headerEnd !== -1) {
            // Extract only the git protocol data (after the blank line)
            responseBody = Buffer.from(bodyStr.slice(headerEnd + 2), 'binary');
          }
        } else {
          // Extract only the git protocol data (after the blank line)
          responseBody = Buffer.from(bodyStr.slice(headerEnd + 4), 'binary');
        }
        
        logger.debug({ 
          originalLength: Buffer.concat(chunks).length,
          protocolDataLength: responseBody.length,
          headerEnd,
          pathInfo
        }, 'Stripped HTTP headers from POST response');
      }
      
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
      const sanitizedError = sanitizeError(err);
      resolve(error(500, `Failed to execute git-http-backend: ${sanitizedError}`));
    });
  });
};
