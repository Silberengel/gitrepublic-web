/**
 * API endpoint for applying patches
 * Only maintainers and owners can apply patches
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fileManager, nostrClient } from '$lib/services/service-registry.js';
import { withRepoValidation } from '$lib/utils/api-handlers.js';
import type { RepoRequestContext, RequestEvent } from '$lib/utils/api-context.js';
import { handleValidationError, handleApiError } from '$lib/utils/error-handler.js';
import { DEFAULT_NOSTR_RELAYS } from '$lib/config.js';
import { MaintainerService } from '$lib/services/nostr/maintainer-service.js';
import { KIND } from '$lib/types/nostr.js';
import logger from '$lib/services/logger.js';
import { join } from 'path';
import { existsSync } from 'fs';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join as pathJoin } from 'path';
import { spawn } from 'child_process';
import { promisify } from 'util';

const repoRoot = typeof process !== 'undefined' && process.env?.GIT_REPO_ROOT
  ? process.env.GIT_REPO_ROOT
  : '/repos';

export const POST: RequestHandler = withRepoValidation(
  async ({ repoContext, requestContext, event }) => {
    const { patchId } = event.params;
    const body = await event.request.json();
    const { branch = 'main', commitMessage } = body;

    if (!patchId) {
      throw handleValidationError('Missing patchId', { operation: 'applyPatch', npub: repoContext.npub, repo: repoContext.repo });
    }

    // Check if user is maintainer or owner
    const maintainerService = new MaintainerService(DEFAULT_NOSTR_RELAYS);
    const isMaintainer = await maintainerService.isMaintainer(requestContext.userPubkeyHex || '', repoContext.repoOwnerPubkey, repoContext.repo);
    
    if (!isMaintainer && requestContext.userPubkeyHex !== repoContext.repoOwnerPubkey) {
      throw handleApiError(new Error('Only repository owners and maintainers can apply patches'), { operation: 'applyPatch', npub: repoContext.npub, repo: repoContext.repo }, 'Unauthorized');
    }

    const repoPath = join(repoRoot, repoContext.npub, `${repoContext.repo}.git`);
    
    if (!existsSync(repoPath)) {
      throw handleApiError(new Error('Repository not found locally'), { operation: 'applyPatch', npub: repoContext.npub, repo: repoContext.repo }, 'Repository not found');
    }

    try {
      // Fetch the patch event
      const patchEvents = await nostrClient.fetchEvents([
        {
          kinds: [KIND.PATCH],
          ids: [patchId],
          limit: 1
        }
      ]);

      if (patchEvents.length === 0) {
        throw handleApiError(new Error('Patch not found'), { operation: 'applyPatch', npub: repoContext.npub, repo: repoContext.repo }, 'Patch not found');
      }

      const patchEvent = patchEvents[0];
      const patchContent = patchEvent.content;

      if (!patchContent || !patchContent.trim()) {
        throw handleApiError(new Error('Patch content is empty'), { operation: 'applyPatch', npub: repoContext.npub, repo: repoContext.repo }, 'Invalid patch');
      }

      // Create temporary patch file
      const tmpPatchFile = pathJoin(tmpdir(), `patch-${patchId}-${Date.now()}.patch`);
      await writeFile(tmpPatchFile, patchContent, 'utf-8');

      try {
        // Apply patch using git apply
        const { simpleGit } = await import('simple-git');
        const git = simpleGit(repoPath);

        // Checkout the target branch
        await git.checkout(branch);

        // Apply the patch
        await new Promise<void>((resolve, reject) => {
          const applyProcess = spawn('git', ['apply', '--check', tmpPatchFile], {
            cwd: repoPath,
            stdio: ['ignore', 'pipe', 'pipe']
          });

          let stderr = '';
          applyProcess.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
          });

          applyProcess.on('close', (code) => {
            if (code !== 0) {
              reject(new Error(`Patch check failed: ${stderr}`));
            } else {
              resolve();
            }
          });

          applyProcess.on('error', reject);
        });

        // Actually apply the patch
        await new Promise<void>((resolve, reject) => {
          const applyProcess = spawn('git', ['apply', tmpPatchFile], {
            cwd: repoPath,
            stdio: ['ignore', 'pipe', 'pipe']
          });

          let stderr = '';
          applyProcess.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
          });

          applyProcess.on('close', (code) => {
            if (code !== 0) {
              reject(new Error(`Patch apply failed: ${stderr}`));
            } else {
              resolve();
            }
          });

          applyProcess.on('error', reject);
        });

        // Stage all changes
        await git.add('.');

        // Commit the changes
        const finalCommitMessage = commitMessage || `Apply patch ${patchId.substring(0, 8)}`;
        await git.commit(finalCommitMessage);

        // Get the commit hash
        const commitHash = await git.revparse(['HEAD']);

        return json({ 
          success: true, 
          commitHash: commitHash.trim(),
          message: 'Patch applied successfully'
        });
      } finally {
        // Clean up temporary patch file
        try {
          await unlink(tmpPatchFile);
        } catch (unlinkErr) {
          logger.warn({ error: unlinkErr, tmpPatchFile }, 'Failed to delete temporary patch file');
        }
      }
    } catch (err) {
      logger.error({ error: err, npub: repoContext.npub, repo: repoContext.repo, patchId }, 'Error applying patch');
      throw err;
    }
  },
  { operation: 'applyPatch', requireRepoExists: true, requireRepoAccess: true }
);
