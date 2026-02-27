/**
 * Commit operations module
 * Handles commit history and diff operations
 */

import simpleGit, { type SimpleGit } from 'simple-git';
import logger from '../../logger.js';
import { sanitizeError } from '../../../utils/security.js';
import { validateRepoName, validateNpub } from './path-validator.js';
import type { Commit, Diff } from '../file-manager.js';

export interface CommitHistoryOptions {
  npub: string;
  repoName: string;
  branch?: string;
  limit?: number;
  path?: string;
  repoPath: string;
}

export interface DiffOptions {
  npub: string;
  repoName: string;
  fromRef: string;
  toRef?: string;
  filePath?: string;
  repoPath: string;
}

/**
 * Get commit history
 */
export async function getCommitHistory(options: CommitHistoryOptions): Promise<Commit[]> {
  let { npub, repoName, branch = 'main', limit = 50, path, repoPath } = options;
  
  // Normalize 'null' string to undefined, then use default
  if (branch === 'null' || branch === null) {
    branch = 'main';
  }
  
  // Validate inputs
  const npubValidation = validateNpub(npub);
  if (!npubValidation.valid) {
    throw new Error(`Invalid npub: ${npubValidation.error}`);
  }
  const repoValidation = validateRepoName(repoName);
  if (!repoValidation.valid) {
    throw new Error(`Invalid repository name: ${repoValidation.error}`);
  }

  const git: SimpleGit = simpleGit(repoPath);

  try {
    logger.operation('Getting commit history', { npub, repoName, branch, limit, path });

    // Check if repository has any commits first
    try {
      const hasCommits = await git.raw(['rev-list', '--count', '--all']);
      const commitCount = parseInt(hasCommits.trim(), 10);
      if (commitCount === 0 || isNaN(commitCount)) {
        logger.debug({ npub, repoName, branch }, 'Repository has no commits, returning empty array');
        return [];
      }
    } catch (checkErr) {
      // If we can't check, try to proceed - git.log will fail if empty anyway
      logger.debug({ error: checkErr, npub, repoName }, 'Could not check commit count, proceeding');
    }

    // Try to get log from the specified branch
    // If the branch doesn't exist or repo is empty, fall back to --all
    const logOptions: {
      maxCount: number;
      from?: string;
      file?: string;
    } = {
      maxCount: limit
    };

    if (path) {
      logOptions.file = path;
    }

    let log;
    try {
      // First try with the specified branch
      logOptions.from = branch;
      log = await git.log(logOptions);
    } catch (branchErr) {
      // If branch doesn't exist or is ambiguous, try --all
      const errorMsg = branchErr instanceof Error ? branchErr.message : String(branchErr);
      if (errorMsg.includes('ambiguous') || errorMsg.includes('unknown') || errorMsg.includes('does not exist')) {
        logger.debug({ npub, repoName, branch, error: errorMsg }, 'Branch does not exist or is ambiguous, trying --all');
        delete logOptions.from;
        log = await git.log(logOptions);
      } else {
        // Re-throw if it's a different error
        throw branchErr;
      }
    }
    
    const commits = log.all.map(commit => ({
      hash: commit.hash,
      message: commit.message,
      author: `${commit.author_name} <${commit.author_email}>`,
      date: commit.date,
      files: commit.diff?.files?.map((f: { file: string }) => f.file) || []
    }));

    logger.operation('Commit history retrieved', { npub, repoName, count: commits.length });
    return commits;
  } catch (error) {
    logger.error({ error, repoPath, branch, limit }, 'Error getting commit history');
    throw new Error(`Failed to get commit history: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Get diff between two commits or for a file
 */
export async function getDiff(options: DiffOptions): Promise<Diff[]> {
  const { npub, repoName, fromRef, toRef = 'HEAD', filePath, repoPath } = options;
  
  // Validate inputs
  const npubValidation = validateNpub(npub);
  if (!npubValidation.valid) {
    throw new Error(`Invalid npub: ${npubValidation.error}`);
  }
  const repoValidation = validateRepoName(repoName);
  if (!repoValidation.valid) {
    throw new Error(`Invalid repository name: ${repoValidation.error}`);
  }

  const git: SimpleGit = simpleGit(repoPath);

  try {
    logger.operation('Getting diff', { npub, repoName, fromRef, toRef, filePath });

    const diffOptions: string[] = [fromRef, toRef];
    if (filePath) {
      diffOptions.push('--', filePath);
    }

    const [diff, stats] = await Promise.all([
      git.diff(diffOptions),
      git.diffSummary(diffOptions)
    ]);

    // Parse diff output
    const files: Diff[] = [];
    const diffLines = diff.split('\n');
    let currentFile = '';
    let currentDiff = '';
    let inFileHeader = false;

    for (const line of diffLines) {
      if (line.startsWith('diff --git')) {
        if (currentFile) {
          files.push({
            file: currentFile,
            additions: 0,
            deletions: 0,
            diff: currentDiff
          });
        }
        const match = line.match(/diff --git a\/(.+?) b\/(.+?)$/);
        if (match) {
          currentFile = match[2];
          currentDiff = line + '\n';
          inFileHeader = true;
        }
      } else {
        currentDiff += line + '\n';
        if (line.startsWith('@@')) {
          inFileHeader = false;
        }
      }
    }

    if (currentFile) {
      files.push({
        file: currentFile,
        additions: 0,
        deletions: 0,
        diff: currentDiff
      });
    }

    // Add stats from diffSummary
    if (stats.files && files.length > 0) {
      for (const statFile of stats.files) {
        const file = files.find(f => f.file === statFile.file);
        if (file && 'insertions' in statFile && 'deletions' in statFile) {
          file.additions = statFile.insertions;
          file.deletions = statFile.deletions;
        }
      }
    }

    logger.operation('Diff retrieved', { npub, repoName, fileCount: files.length });
    return files;
  } catch (error) {
    const sanitizedError = sanitizeError(error);
    logger.error({ error: sanitizedError, repoPath, fromRef, toRef }, 'Error getting diff');
    throw new Error(`Failed to get diff: ${sanitizedError}`);
  }
}
