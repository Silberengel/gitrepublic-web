/**
 * API endpoint for reading and writing files in a repository
 */

import { json, error } from '@sveltejs/kit';
// @ts-ignore - SvelteKit generates this type
import type { RequestHandler } from './$types';
import { FileManager } from '$lib/services/git/file-manager.js';
import { MaintainerService } from '$lib/services/nostr/maintainer-service.js';
import { DEFAULT_NOSTR_RELAYS } from '$lib/config.js';
import { nip19 } from 'nostr-tools';
import { verifyNIP98Auth } from '$lib/services/nostr/nip98-auth.js';
import { auditLogger } from '$lib/services/security/audit-logger.js';

const repoRoot = process.env.GIT_REPO_ROOT || '/repos';
const fileManager = new FileManager(repoRoot);
const maintainerService = new MaintainerService(DEFAULT_NOSTR_RELAYS);

export const GET: RequestHandler = async ({ params, url, request }: { params: { npub?: string; repo?: string }; url: URL; request: Request }) => {
  const { npub, repo } = params;
  const filePath = url.searchParams.get('path');
  const ref = url.searchParams.get('ref') || 'HEAD';
  const userPubkey = url.searchParams.get('userPubkey') || request.headers.get('x-user-pubkey');

  if (!npub || !repo || !filePath) {
    return error(400, 'Missing npub, repo, or path parameter');
  }

  try {
    if (!fileManager.repoExists(npub, repo)) {
      return error(404, 'Repository not found');
    }

    // Check repository privacy
    let repoOwnerPubkey: string;
    try {
      const decoded = nip19.decode(npub);
      if (decoded.type === 'npub') {
        repoOwnerPubkey = decoded.data as string;
      } else {
        return error(400, 'Invalid npub format');
      }
    } catch {
      return error(400, 'Invalid npub format');
    }

    const canView = await maintainerService.canView(userPubkey || null, repoOwnerPubkey, repo);
    if (!canView) {
      const clientIp = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';
      auditLogger.logFileOperation(
        userPubkey || null,
        clientIp,
        'read',
        `${npub}/${repo}`,
        filePath,
        'denied',
        'Insufficient permissions'
      );
      return error(403, 'This repository is private. Only owners and maintainers can view it.');
    }

    const clientIp = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';
    try {
      const fileContent = await fileManager.getFileContent(npub, repo, filePath, ref);
      auditLogger.logFileOperation(
        userPubkey || null,
        clientIp,
        'read',
        `${npub}/${repo}`,
        filePath,
        'success'
      );
      return json(fileContent);
    } catch (err) {
      auditLogger.logFileOperation(
        userPubkey || null,
        clientIp,
        'read',
        `${npub}/${repo}`,
        filePath,
        'failure',
        err instanceof Error ? err.message : String(err)
      );
      throw err;
    }
  } catch (err) {
    // Security: Sanitize error messages to prevent leaking sensitive data
    const sanitizedError = err instanceof Error ? err.message.replace(/nsec[0-9a-z]+/gi, '[REDACTED]').replace(/[0-9a-f]{64}/g, '[REDACTED]') : 'Failed to read file';
    console.error('Error reading file:', sanitizedError);
    return error(500, sanitizedError);
  }
};

export const POST: RequestHandler = async ({ params, url, request }: { params: { npub?: string; repo?: string }; url: URL; request: Request }) => {
  const { npub, repo } = params;

  if (!npub || !repo) {
    return error(400, 'Missing npub or repo parameter');
  }

  try {
    const body = await request.json();
    const { path, content, commitMessage, authorName, authorEmail, branch, action, userPubkey, useNIP07, nsecKey } = body;
    
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

    if (!fileManager.repoExists(npub, repo)) {
      return error(404, 'Repository not found');
    }

    // Check if user is a maintainer
    let repoOwnerPubkey: string;
    try {
      const decoded = nip19.decode(npub);
      if (decoded.type === 'npub') {
        repoOwnerPubkey = decoded.data as string;
      } else {
        return error(400, 'Invalid npub format');
      }
    } catch {
      return error(400, 'Invalid npub format');
    }

    // Convert userPubkey to hex if needed
    let userPubkeyHex = userPubkey;
    try {
      const userDecoded = nip19.decode(userPubkey);
      // @ts-ignore - nip19 types are incomplete, but we know npub returns string
      if (userDecoded.type === 'npub') {
        userPubkeyHex = userDecoded.data as unknown as string;
      }
    } catch {
      // Assume it's already a hex pubkey
    }

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
      nip98Event?: any;
      nsecKey?: string;
    } = {};
    
    if (useNIP07) {
      signingOptions.useNIP07 = true;
    } else if (nip98Event) {
      signingOptions.nip98Event = nip98Event;
    }
    // Explicitly ignore nsecKey from client requests - it's a security risk
    // Server-side signing should use NOSTRGIT_SECRET_KEY environment variable instead
    if (nsecKey) {
      // Security: Log warning but never log the actual key value
      const clientIp = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';
      console.warn(`[SECURITY] Client attempted to send nsecKey in request from IP ${clientIp}. This is not allowed for security reasons.`);
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
        await fileManager.deleteFile(
          npub,
          repo,
          path,
          commitMessage,
          authorName,
          authorEmail,
          branch || 'main',
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
        await fileManager.writeFile(
          npub,
          repo,
          path,
          content,
          commitMessage,
          authorName,
          authorEmail,
          branch || 'main',
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
    // Security: Sanitize error messages to prevent leaking sensitive data
    const sanitizedError = err instanceof Error ? err.message.replace(/nsec[0-9a-z]+/gi, '[REDACTED]').replace(/[0-9a-f]{64}/g, '[REDACTED]') : 'Failed to write file';
    console.error('Error writing file:', sanitizedError);
    return error(500, sanitizedError);
  }
};
