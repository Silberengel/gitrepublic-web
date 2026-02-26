/**
 * Write operations module
 * Handles file writing, deletion, and commit operations
 */

import { join, dirname, resolve } from 'path';
import simpleGit, { type SimpleGit } from 'simple-git';
import logger from '../../logger.js';
import { sanitizeError } from '../../../utils/security.js';
import { isValidBranchName } from '../../../utils/security.js';
import { validateFilePath, validateRepoName, validateNpub } from './path-validator.js';
import { getOrCreateWorktree, removeWorktree } from './worktree-manager.js';
import { createGitCommitSignature } from '../commit-signer.js';
import type { NostrEvent } from '../../../types/nostr.js';

export interface WriteFileOptions {
  npub: string;
  repoName: string;
  filePath: string;
  content: string;
  commitMessage: string;
  authorName: string;
  authorEmail: string;
  branch?: string;
  repoPath: string;
  worktreePath: string;
  signingOptions?: {
    commitSignatureEvent?: NostrEvent;
    useNIP07?: boolean;
    nip98Event?: NostrEvent;
    nsecKey?: string;
  };
  saveCommitSignature?: (worktreePath: string, event: NostrEvent) => Promise<void>;
  isRepoPrivate?: (npub: string, repoName: string) => Promise<boolean>;
}

/**
 * Write file and commit changes
 */
export async function writeFile(options: WriteFileOptions): Promise<void> {
  const {
    npub,
    repoName,
    filePath,
    content,
    commitMessage,
    authorName,
    authorEmail,
    branch = 'main',
    repoPath,
    worktreePath,
    signingOptions,
    saveCommitSignature,
    isRepoPrivate
  } = options;

  // Validate inputs
  const npubValidation = validateNpub(npub);
  if (!npubValidation.valid) {
    throw new Error(`Invalid npub: ${npubValidation.error}`);
  }
  const repoValidation = validateRepoName(repoName);
  if (!repoValidation.valid) {
    throw new Error(`Invalid repository name: ${repoValidation.error}`);
  }
  
  const pathValidation = validateFilePath(filePath);
  if (!pathValidation.valid) {
    throw new Error(`Invalid file path: ${pathValidation.error}`);
  }

  if (!isValidBranchName(branch)) {
    throw new Error(`Invalid branch name: ${branch}`);
  }

  // Validate content size (500 MB max)
  const maxFileSize = 500 * 1024 * 1024;
  if (Buffer.byteLength(content, 'utf-8') > maxFileSize) {
    throw new Error(`File is too large (max ${maxFileSize / 1024 / 1024} MB)`);
  }

  // Validate commit message
  if (!commitMessage || typeof commitMessage !== 'string' || commitMessage.trim().length === 0) {
    throw new Error('Commit message is required');
  }
  if (commitMessage.length > 1000) {
    throw new Error('Commit message is too long (max 1000 characters)');
  }

  // Validate author info
  if (!authorName || typeof authorName !== 'string' || authorName.trim().length === 0) {
    throw new Error('Author name is required');
  }
  if (!authorEmail || typeof authorEmail !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(authorEmail)) {
    throw new Error('Valid author email is required');
  }

  try {
    logger.operation('Writing file', { npub, repoName, filePath, branch });

    const workGit: SimpleGit = simpleGit(worktreePath);

    // Write the file
    const validatedPath = pathValidation.normalized || filePath;
    const fullFilePath = join(worktreePath, validatedPath);
    const fileDir = dirname(fullFilePath);
    
    // Security: ensure resolved path is within workDir
    const resolvedPath = resolve(fullFilePath).replace(/\\/g, '/');
    const resolvedWorkDir = resolve(worktreePath).replace(/\\/g, '/');
    if (!resolvedPath.startsWith(resolvedWorkDir + '/') && resolvedPath !== resolvedWorkDir) {
      throw new Error('Path validation failed: resolved path outside work directory');
    }
    
    // Ensure directory exists
    const { mkdir } = await import('fs/promises');
    await mkdir(fileDir, { recursive: true });

    const { writeFile: writeFileFs } = await import('fs/promises');
    await writeFileFs(fullFilePath, content, 'utf-8');

    // Stage the file
    await workGit.add(validatedPath);

    // Sign commit if signing options are provided
    let finalCommitMessage = commitMessage;
    let signatureEvent: NostrEvent | null = null;
    
    if (signingOptions && (signingOptions.commitSignatureEvent || signingOptions.useNIP07 || signingOptions.nip98Event || signingOptions.nsecKey)) {
      try {
        const result = await createGitCommitSignature(
          commitMessage,
          authorName,
          authorEmail,
          signingOptions
        );
        finalCommitMessage = result.signedMessage;
        signatureEvent = signingOptions.commitSignatureEvent || result.signatureEvent;
      } catch (err) {
        const sanitizedErr = sanitizeError(err);
        logger.warn({ error: sanitizedErr, repoPath, filePath }, 'Failed to sign commit');
      }
    }

    // Commit
    const commitResult = await workGit.commit(finalCommitMessage, [filePath], {
      '--author': `${authorName} <${authorEmail}>`
    }) as string | { commit: string };

    // Get commit hash
    let commitHash: string;
    if (typeof commitResult === 'string') {
      commitHash = commitResult.trim();
    } else if (commitResult && typeof commitResult === 'object' && 'commit' in commitResult) {
      commitHash = String(commitResult.commit);
    } else {
      commitHash = await workGit.revparse(['HEAD']);
    }

    // Save commit signature event if signing was used
    if (signatureEvent && saveCommitSignature) {
      try {
        await saveCommitSignature(worktreePath, signatureEvent);
        
        // Publish to relays if repo is public
        if (isRepoPrivate && !(await isRepoPrivate(npub, repoName))) {
          try {
            const { NostrClient } = await import('../../nostr/nostr-client.js');
            const { DEFAULT_NOSTR_RELAYS } = await import('../../../config.js');
            const { getUserRelays } = await import('../../nostr/user-relays.js');
            const { combineRelays } = await import('../../../config.js');
            const { nip19 } = await import('nostr-tools');
            const { requireNpubHex } = await import('../../../utils/npub-utils.js');
            
            const userPubkeyHex = requireNpubHex(npub);
            const nostrClient = new NostrClient(DEFAULT_NOSTR_RELAYS);
            const { inbox, outbox } = await getUserRelays(userPubkeyHex, nostrClient);
            
            const userRelays = outbox.length > 0 
              ? combineRelays(outbox, DEFAULT_NOSTR_RELAYS)
              : inbox.length > 0
              ? combineRelays(inbox, DEFAULT_NOSTR_RELAYS)
              : DEFAULT_NOSTR_RELAYS;
            
            const publishResult = await nostrClient.publishEvent(signatureEvent, userRelays);
            if (publishResult.success.length > 0) {
              logger.debug({ 
                eventId: signatureEvent.id, 
                commitHash,
                relays: publishResult.success 
              }, 'Published commit signature event to relays');
            }
          } catch (publishErr) {
            logger.debug({ error: publishErr }, 'Failed to publish commit signature event to relays');
          }
        }
      } catch (err) {
        logger.debug({ error: err }, 'Failed to save commit signature event');
      }
    }

    logger.operation('File written', { npub, repoName, filePath, commitHash });
  } catch (error) {
    logger.error({ error, repoPath, filePath, npub }, 'Error writing file');
    throw new Error(`Failed to write file: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Delete a file
 */
export async function deleteFile(options: Omit<WriteFileOptions, 'content'>): Promise<void> {
  const {
    npub,
    repoName,
    filePath,
    commitMessage,
    authorName,
    authorEmail,
    branch = 'main',
    repoPath,
    worktreePath,
    signingOptions,
    saveCommitSignature
  } = options;

  // Validate inputs
  const npubValidation = validateNpub(npub);
  if (!npubValidation.valid) {
    throw new Error(`Invalid npub: ${npubValidation.error}`);
  }
  const repoValidation = validateRepoName(repoName);
  if (!repoValidation.valid) {
    throw new Error(`Invalid repository name: ${repoValidation.error}`);
  }
  
  const pathValidation = validateFilePath(filePath);
  if (!pathValidation.valid) {
    throw new Error(`Invalid file path: ${pathValidation.error}`);
  }

  if (!isValidBranchName(branch)) {
    throw new Error(`Invalid branch name: ${branch}`);
  }

  if (!commitMessage || typeof commitMessage !== 'string' || commitMessage.trim().length === 0) {
    throw new Error('Commit message is required');
  }

  if (!authorName || typeof authorName !== 'string' || authorName.trim().length === 0) {
    throw new Error('Author name is required');
  }
  if (!authorEmail || typeof authorEmail !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(authorEmail)) {
    throw new Error('Valid author email is required');
  }

  try {
    logger.operation('Deleting file', { npub, repoName, filePath, branch });

    const workGit: SimpleGit = simpleGit(worktreePath);

    // Remove the file
    const validatedPath = pathValidation.normalized || filePath;
    const fullFilePath = join(worktreePath, validatedPath);
    
    // Security: ensure resolved path is within workDir
    const resolvedPath = resolve(fullFilePath).replace(/\\/g, '/');
    const resolvedWorkDir = resolve(worktreePath).replace(/\\/g, '/');
    if (!resolvedPath.startsWith(resolvedWorkDir + '/') && resolvedPath !== resolvedWorkDir) {
      throw new Error('Path validation failed: resolved path outside work directory');
    }
    
    const { accessSync, constants } = await import('fs');
    const { unlink } = await import('fs/promises');
    try {
      accessSync(fullFilePath, constants.F_OK);
      await unlink(fullFilePath);
    } catch {
      // File doesn't exist, that's fine - git rm will handle it
    }

    // Stage the deletion
    await workGit.rm([validatedPath]);

    // Sign commit if signing options are provided
    let finalCommitMessage = commitMessage;
    if (signingOptions && (signingOptions.commitSignatureEvent || signingOptions.useNIP07 || signingOptions.nip98Event || signingOptions.nsecKey)) {
      try {
        const { signedMessage } = await createGitCommitSignature(
          commitMessage,
          authorName,
          authorEmail,
          signingOptions
        );
        finalCommitMessage = signedMessage;
      } catch (err) {
        const sanitizedErr = sanitizeError(err);
        logger.warn({ error: sanitizedErr, repoPath, filePath }, 'Failed to sign commit');
      }
    }

    // Commit
    await workGit.commit(finalCommitMessage, [filePath], {
      '--author': `${authorName} <${authorEmail}>`
    });

    logger.operation('File deleted', { npub, repoName, filePath });
  } catch (error) {
    logger.error({ error, repoPath, filePath, npub }, 'Error deleting file');
    throw new Error(`Failed to delete file: ${error instanceof Error ? error.message : String(error)}`);
  }
}
