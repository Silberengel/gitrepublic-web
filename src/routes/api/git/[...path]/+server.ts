/**
 * Git HTTP backend API route
 * Handles git clone, push, pull operations via git-http-backend
 */

import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { RepoManager } from '$lib/services/git/repo-manager.js';
import { verifyEvent } from 'nostr-tools';
import { nip19 } from 'nostr-tools';
import { spawn, execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { DEFAULT_NOSTR_RELAYS } from '$lib/config.js';
import { NostrClient } from '$lib/services/nostr/nostr-client.js';
import { KIND } from '$lib/types/nostr.js';
import type { NostrEvent } from '$lib/types/nostr.js';

const repoRoot = process.env.GIT_REPO_ROOT || '/repos';
const repoManager = new RepoManager(repoRoot);
const nostrClient = new NostrClient(DEFAULT_NOSTR_RELAYS);

// Path to git-http-backend (common locations)
const GIT_HTTP_BACKEND_PATHS = [
  '/usr/lib/git-core/git-http-backend',
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
 * Verify NIP-98 authentication for push operations
 */
async function verifyNIP98Auth(
  request: Request,
  expectedPubkey: string
): Promise<{ valid: boolean; error?: string }> {
  const authHeader = request.headers.get('Authorization');
  
  if (!authHeader || !authHeader.startsWith('Nostr ')) {
    return { valid: false, error: 'Missing or invalid Authorization header (expected "Nostr <event>")' };
  }

  try {
    const eventJson = authHeader.slice(7); // Remove "Nostr " prefix
    const nostrEvent: NostrEvent = JSON.parse(eventJson);

    // Verify event signature
    if (!verifyEvent(nostrEvent)) {
      return { valid: false, error: 'Invalid event signature' };
    }

    // Verify pubkey matches repo owner
    if (nostrEvent.pubkey !== expectedPubkey) {
      return { valid: false, error: 'Event pubkey does not match repository owner' };
    }

    // Verify event is recent (within last 5 minutes)
    const now = Math.floor(Date.now() / 1000);
    const eventAge = now - nostrEvent.created_at;
    if (eventAge > 300) {
      return { valid: false, error: 'Authentication event is too old (must be within 5 minutes)' };
    }
    if (eventAge < 0) {
      return { valid: false, error: 'Authentication event has future timestamp' };
    }

    // Verify the event method and URL match the request
    const methodTag = nostrEvent.tags.find(t => t[0] === 'method');
    const urlTag = nostrEvent.tags.find(t => t[0] === 'u');
    
    if (methodTag && methodTag[1] !== request.method) {
      return { valid: false, error: 'Event method does not match request method' };
    }

    return { valid: true };
  } catch (err) {
    return {
      valid: false,
      error: `Failed to parse or verify authentication: ${err instanceof Error ? err.message : String(err)}`
    };
  }
}

/**
 * Get repository announcement to extract clone URLs for post-receive sync
 */
async function getRepoAnnouncement(npub: string, repoName: string): Promise<NostrEvent | null> {
  try {
    const decoded = nip19.decode(npub);
    if (decoded.type !== 'npub') {
      return null;
    }
    const pubkey = decoded.data as string;

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

  // Validate npub format
  try {
    const decoded = nip19.decode(npub);
    if (decoded.type !== 'npub') {
      return error(400, 'Invalid npub format');
    }
  } catch {
    return error(400, 'Invalid npub format');
  }

  // Get repository path
  const repoPath = join(repoRoot, npub, `${repoName}.git`);
  if (!repoManager.repoExists(repoPath)) {
    return error(404, 'Repository not found');
  }

  // Find git-http-backend
  const gitHttpBackend = findGitHttpBackend();
  if (!gitHttpBackend) {
    return error(500, 'git-http-backend not found. Please install git.');
  }

  // Build PATH_INFO
  // For info/refs, git-http-backend expects: /{npub}/{repo-name}.git/info/refs
  // For other operations: /{npub}/{repo-name}.git/{git-path}
  const pathInfo = gitPath ? `/${npub}/${repoName}.git/${gitPath}` : `/${npub}/${repoName}.git/info/refs`;

  // Set up environment variables for git-http-backend
  const envVars = {
    ...process.env,
    GIT_PROJECT_ROOT: repoRoot,
    GIT_HTTP_EXPORT_ALL: '1',
    REQUEST_METHOD: request.method,
    PATH_INFO: pathInfo,
    QUERY_STRING: url.searchParams.toString(),
    CONTENT_TYPE: request.headers.get('Content-Type') || '',
    CONTENT_LENGTH: request.headers.get('Content-Length') || '0',
    HTTP_USER_AGENT: request.headers.get('User-Agent') || '',
  };

  // Execute git-http-backend
  return new Promise((resolve) => {
    const gitProcess = spawn(gitHttpBackend, [], {
      env: envVars,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const chunks: Buffer[] = [];
    let errorOutput = '';

    gitProcess.stdout.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    gitProcess.stderr.on('data', (chunk: Buffer) => {
      errorOutput += chunk.toString();
    });

    gitProcess.on('close', (code) => {
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
  let repoOwnerPubkey: string;
  try {
    const decoded = nip19.decode(npub);
    if (decoded.type !== 'npub') {
      return error(400, 'Invalid npub format');
    }
    repoOwnerPubkey = decoded.data as string;
  } catch {
    return error(400, 'Invalid npub format');
  }

  // Get repository path
  const repoPath = join(repoRoot, npub, `${repoName}.git`);
  if (!repoManager.repoExists(repoPath)) {
    return error(404, 'Repository not found');
  }

  // For push operations (git-receive-pack), require NIP-98 authentication
  if (gitPath === 'git-receive-pack' || path.includes('git-receive-pack')) {
    const authResult = await verifyNIP98Auth(request, repoOwnerPubkey);
    if (!authResult.valid) {
      return error(401, authResult.error || 'Authentication required');
    }
  }

  // Find git-http-backend
  const gitHttpBackend = findGitHttpBackend();
  if (!gitHttpBackend) {
    return error(500, 'git-http-backend not found. Please install git.');
  }

  // Build PATH_INFO
  const pathInfo = gitPath ? `/${npub}/${repoName}.git/${gitPath}` : `/${npub}/${repoName}.git`;

  // Get request body
  const body = await request.arrayBuffer();
  const bodyBuffer = Buffer.from(body);

  // Set up environment variables for git-http-backend
  const envVars = {
    ...process.env,
    GIT_PROJECT_ROOT: repoRoot,
    GIT_HTTP_EXPORT_ALL: '1',
    REQUEST_METHOD: request.method,
    PATH_INFO: pathInfo,
    QUERY_STRING: url.searchParams.toString(),
    CONTENT_TYPE: request.headers.get('Content-Type') || 'application/x-git-receive-pack-request',
    CONTENT_LENGTH: bodyBuffer.length.toString(),
    HTTP_USER_AGENT: request.headers.get('User-Agent') || '',
  };

  // Execute git-http-backend
  return new Promise((resolve) => {
    const gitProcess = spawn(gitHttpBackend, [], {
      env: envVars,
      stdio: ['pipe', 'pipe', 'pipe']
    });

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
                console.error('Failed to sync to remotes after push:', err);
              });
            }
          }
        } catch (err) {
          console.error('Failed to sync to remotes:', err);
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
      resolve(error(500, `Failed to execute git-http-backend: ${err.message}`));
    });
  });
};
