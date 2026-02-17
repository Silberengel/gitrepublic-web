/**
 * API endpoint for downloading repository as ZIP
 */

import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { FileManager } from '$lib/services/git/file-manager.js';
import { MaintainerService } from '$lib/services/nostr/maintainer-service.js';
import { DEFAULT_NOSTR_RELAYS } from '$lib/config.js';
import { nip19 } from 'nostr-tools';
import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { createReadStream } from 'fs';
import logger from '$lib/services/logger.js';

const execAsync = promisify(exec);
const repoRoot = process.env.GIT_REPO_ROOT || '/repos';
const fileManager = new FileManager(repoRoot);
const maintainerService = new MaintainerService(DEFAULT_NOSTR_RELAYS);

export const GET: RequestHandler = async ({ params, url, request }) => {
  const { npub, repo } = params;
  const ref = url.searchParams.get('ref') || 'HEAD';
  const format = url.searchParams.get('format') || 'zip'; // zip or tar.gz
  const userPubkey = url.searchParams.get('userPubkey') || request.headers.get('x-user-pubkey');

  if (!npub || !repo) {
    return error(400, 'Missing npub or repo parameter');
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
      return error(403, 'This repository is private. Only owners and maintainers can view it.');
    }

    const repoPath = join(repoRoot, npub, `${repo}.git`);
    const tempDir = join(repoRoot, '..', 'temp-downloads');
    const workDir = join(tempDir, `${npub}-${repo}-${Date.now()}`);
    const archiveName = `${repo}-${ref}.${format === 'tar.gz' ? 'tar.gz' : 'zip'}`;
    const archivePath = join(tempDir, archiveName);

    try {
      // Create temp directory
      await execAsync(`mkdir -p "${tempDir}"`);
      await execAsync(`mkdir -p "${workDir}"`);

      // Clone repository to temp directory
      await execAsync(`git clone "${repoPath}" "${workDir}"`);

      // Checkout specific ref if not HEAD
      if (ref !== 'HEAD') {
        await execAsync(`cd "${workDir}" && git checkout "${ref}"`);
      }

      // Remove .git directory
      await execAsync(`rm -rf "${workDir}/.git"`);

      // Create archive
      if (format === 'tar.gz') {
        await execAsync(`cd "${tempDir}" && tar -czf "${archiveName}" -C "${workDir}" .`);
      } else {
        // Use zip command (requires zip utility)
        await execAsync(`cd "${workDir}" && zip -r "${archivePath}" .`);
      }

      // Read archive file
      const archiveBuffer = readFileSync(archivePath);

      // Clean up
      await execAsync(`rm -rf "${workDir}"`);
      await execAsync(`rm -f "${archivePath}"`);

      // Return archive
      return new Response(archiveBuffer, {
        headers: {
          'Content-Type': format === 'tar.gz' ? 'application/gzip' : 'application/zip',
          'Content-Disposition': `attachment; filename="${archiveName}"`,
          'Content-Length': archiveBuffer.length.toString()
        }
      });
    } catch (archiveError) {
      // Clean up on error
      await execAsync(`rm -rf "${workDir}"`).catch(() => {});
      await execAsync(`rm -f "${archivePath}"`).catch(() => {});
      throw archiveError;
    }
  } catch (err) {
    logger.error({ error: err, npub, repo }, 'Error creating repository archive');
    return error(500, err instanceof Error ? err.message : 'Failed to create repository archive');
  }
};
