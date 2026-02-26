/**
 * Worktree management module
 * Handles git worktree operations with proper cleanup
 */

import { join, resolve, dirname } from 'path';
import { spawn } from 'child_process';
import simpleGit, { type SimpleGit } from 'simple-git';
import logger from '../../logger.js';
import { sanitizeError } from '../../../utils/security.js';
import { execGitProcess } from '../../../utils/git-process.js';

export interface WorktreeOptions {
  repoPath: string;
  branch: string;
  npub: string;
  repoName: string;
  repoRoot: string;
}

/**
 * Get or create a worktree for a branch
 */
export async function getOrCreateWorktree(
  options: WorktreeOptions
): Promise<string> {
  const { repoPath, branch, npub, repoName, repoRoot } = options;
  
  const worktreeRoot = join(repoRoot, npub, `${repoName}.worktrees`);
  const worktreePath = resolve(join(worktreeRoot, branch));
  const resolvedWorktreeRoot = resolve(worktreeRoot);
  
  // Security: Ensure resolved path is still within worktreeRoot
  const resolvedPath = worktreePath.replace(/\\/g, '/');
  const resolvedRoot = resolvedWorktreeRoot.replace(/\\/g, '/');
  if (!resolvedPath.startsWith(resolvedRoot + '/')) {
    throw new Error('Path traversal detected: worktree path outside allowed root');
  }
  
  const { mkdir, rm } = await import('fs/promises');
  
  // Ensure worktree root exists
  await mkdir(resolvedWorktreeRoot, { recursive: true });
  
  const git = simpleGit(repoPath);
  
  // Check if worktree already exists
  try {
    const worktrees = await git.raw(['worktree', 'list', '--porcelain']);
    const worktreeLines = worktrees.split('\n');
    let currentWorktreePath = '';
    
    for (const line of worktreeLines) {
      if (line.startsWith('worktree ')) {
        currentWorktreePath = line.substring(9).trim();
      } else if (line.startsWith('branch ') && currentWorktreePath) {
        const branchRef = line.substring(7).trim();
        if (branchRef === `refs/heads/${branch}` || branchRef.endsWith(`/${branch}`)) {
          logger.debug({ branch, worktreePath: currentWorktreePath }, 'Worktree already exists');
          return currentWorktreePath;
        }
      }
    }
  } catch (err) {
    logger.debug({ error: err }, 'Failed to list worktrees, will create new one');
  }
  
  // Check if directory exists but is not a valid worktree
  try {
    const { accessSync, constants } = await import('fs');
    accessSync(worktreePath, constants.F_OK);
    // Directory exists, check if it's a valid git repo
    const worktreeGit = simpleGit(worktreePath);
    await worktreeGit.status();
    logger.debug({ branch, worktreePath }, 'Existing directory is valid worktree');
    return worktreePath;
  } catch {
    // Directory doesn't exist or is invalid, will create new worktree
  }
  
  // Remove existing directory if it exists but is invalid
  try {
    await rm(worktreePath, { recursive: true, force: true });
  } catch {
    // Ignore errors - directory might not exist
  }
  
  // Create worktree
  try {
    await execGitProcess(['worktree', 'add', worktreePath, branch], {
      cwd: repoPath,
      timeoutMs: 5 * 60 * 1000 // 5 minutes
    });
  } catch (error: any) {
    const stderr = error.message || '';
    
    // If branch doesn't exist, create it first
    if (stderr.includes('fatal: invalid reference') || 
        stderr.includes('fatal: not a valid object name') || 
        stderr.includes('Ungültige Referenz')) {
      
      // Find source branch
      const branches = await git.branch(['-a']);
      let sourceBranch = 'HEAD';
      
      if (branches.all.includes('HEAD') || branches.all.includes('origin/HEAD')) {
        sourceBranch = 'HEAD';
      } else if (branches.all.includes('main') || branches.all.includes('origin/main')) {
        sourceBranch = 'main';
      } else if (branches.all.includes('master') || branches.all.includes('origin/master')) {
        sourceBranch = 'master';
      } else {
        const firstBranch = branches.all.find(b => !b.includes('HEAD'));
        if (firstBranch) {
          sourceBranch = firstBranch.replace(/^origin\//, '');
        }
      }
      
      // Create branch
      try {
        await execGitProcess(['branch', branch, sourceBranch], {
          cwd: repoPath,
          timeoutMs: 2 * 60 * 1000
        });
      } catch (branchError: any) {
        // Try creating orphan branch
        if (branchError.message?.includes('fatal: invalid reference')) {
          await execGitProcess(['branch', branch], {
            cwd: repoPath,
            timeoutMs: 2 * 60 * 1000
          });
        } else {
          throw branchError;
        }
      }
      
      // Retry worktree creation
      try {
        await execGitProcess(['worktree', 'add', worktreePath, branch], {
          cwd: repoPath,
          timeoutMs: 5 * 60 * 1000
        });
      } catch (retryError: any) {
        // Try with --orphan as last resort
        if (retryError.message?.includes('fatal: invalid reference')) {
          await execGitProcess(['worktree', 'add', '--orphan', branch, worktreePath], {
            cwd: repoPath,
            timeoutMs: 5 * 60 * 1000
          });
        } else {
          throw retryError;
        }
      }
    } else {
      throw error;
    }
  }
  
  // Verify worktree was created
  const { accessSync, constants } = await import('fs');
  try {
    accessSync(worktreePath, constants.F_OK);
  } catch {
    throw new Error(`Worktree directory was not created: ${worktreePath}`);
  }
  
  // Verify it's a valid git repository
  const worktreeGit = simpleGit(worktreePath);
  try {
    await worktreeGit.status();
  } catch {
    throw new Error(`Created worktree directory is not a valid git repository: ${worktreePath}`);
  }
  
  logger.operation('Worktree created', { branch, worktreePath });
  return worktreePath;
}

/**
 * Remove a worktree
 */
export async function removeWorktree(
  repoPath: string,
  worktreePath: string
): Promise<void> {
  try {
    await execGitProcess(['worktree', 'remove', worktreePath], {
      cwd: repoPath,
      timeoutMs: 2 * 60 * 1000
    });
  } catch (error: any) {
    // Try force remove
    try {
      await execGitProcess(['worktree', 'remove', '--force', worktreePath], {
        cwd: repoPath,
        timeoutMs: 2 * 60 * 1000
      });
    } catch {
      // Last resort: delete directory
      const { rm } = await import('fs/promises');
      await rm(worktreePath, { recursive: true, force: true });
      logger.warn({ worktreePath }, 'Force removed worktree directory');
    }
  }
  
  logger.operation('Worktree removed', { worktreePath });
}
