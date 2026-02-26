/**
 * Branch operations module
 * Handles branch creation, deletion, and listing
 */

import simpleGit, { type SimpleGit } from 'simple-git';
import logger from '../../logger.js';
import { sanitizeError } from '../../../utils/security.js';
import { isValidBranchName } from '../../../utils/security.js';
import { validateRepoName, validateNpub } from './path-validator.js';
import { repoCache, RepoCache } from '../repo-cache.js';

export interface BranchListOptions {
  npub: string;
  repoName: string;
  repoPath: string;
  getDefaultBranch: (npub: string, repoName: string) => Promise<string>;
}

/**
 * Get list of branches in a repository
 */
export async function getBranches(options: BranchListOptions): Promise<string[]> {
  const { npub, repoName, repoPath, getDefaultBranch } = options;
  
  // Validate inputs
  const npubValidation = validateNpub(npub);
  if (!npubValidation.valid) {
    throw new Error(`Invalid npub: ${npubValidation.error}`);
  }
  const repoValidation = validateRepoName(repoName);
  if (!repoValidation.valid) {
    throw new Error(`Invalid repository name: ${repoValidation.error}`);
  }

  // Check cache first (cache for 2 minutes)
  const cacheKey = RepoCache.branchListKey(npub, repoName);
  const cached = repoCache.get<string[]>(cacheKey);
  if (cached !== null) {
    logger.debug({ npub, repoName, cachedCount: cached.length }, 'Returning cached branch list');
    return cached;
  }

  const git: SimpleGit = simpleGit(repoPath);

  try {
    logger.operation('Listing branches', { npub, repoName });
    
    const allBranches = new Set<string>();
    
    // Get local branches
    try {
      const localBranches = await git.branchLocal();
      localBranches.all
        .filter(b => !b.startsWith('remotes/') && !b.includes('HEAD'))
        .forEach(b => allBranches.add(b));
    } catch {
      // Ignore if local branches fail
    }
    
    // Get remote branches
    try {
      const remoteBranches = await git.branch(['-r']);
      remoteBranches.all
        .map(b => b.replace(/^origin\//, ''))
        .filter(b => !b.includes('HEAD'))
        .forEach(b => allBranches.add(b));
    } catch {
      // Ignore if remote branches fail
    }
    
    // If no branches found, try listing refs directly (for bare repos)
    if (allBranches.size === 0) {
      try {
        const refs = await git.raw(['for-each-ref', '--format=%(refname:short)', 'refs/heads/']);
        if (refs) {
          refs.trim().split('\n').forEach(b => {
            if (b && !b.includes('HEAD')) {
              allBranches.add(b);
            }
          });
        }
      } catch {
        // If that fails too, continue with empty set
      }
    }
    
    // Sort branches: default branch first, then alphabetically
    let branchList = Array.from(allBranches);
    try {
      const defaultBranch = await getDefaultBranch(npub, repoName);
      if (defaultBranch) {
        branchList.sort((a, b) => {
          if (a === defaultBranch) return -1;
          if (b === defaultBranch) return 1;
          return a.localeCompare(b);
        });
      } else {
        branchList.sort();
      }
    } catch {
      branchList.sort();
    }
    
    // Cache the result (cache for 2 minutes)
    repoCache.set(cacheKey, branchList, 2 * 60 * 1000);
    
    logger.operation('Branches listed', { npub, repoName, count: branchList.length });
    return branchList;
  } catch (error) {
    logger.error({ error, repoPath }, 'Error getting branches');
    const defaultBranches = ['main', 'master'];
    repoCache.set(cacheKey, defaultBranches, 30 * 1000);
    return defaultBranches;
  }
}

/**
 * Validate branch name
 */
export function validateBranchName(branch: string): { valid: boolean; error?: string } {
  if (!isValidBranchName(branch)) {
    return { valid: false, error: `Invalid branch name: ${branch}` };
  }
  return { valid: true };
}
