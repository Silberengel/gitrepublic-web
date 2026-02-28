/**
 * Admin API endpoint for listing all repositories
 * Only accessible to users with unlimited access
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { readdir, stat } from 'fs/promises';
import { join, resolve } from 'path';
import { existsSync } from 'fs';
import { extractRequestContext } from '$lib/utils/api-context.js';
import { isAdmin } from '$lib/utils/admin-check.js';
import { handleApiError, handleAuthorizationError } from '$lib/utils/error-handler.js';
import logger from '$lib/services/logger.js';

const repoRoot = typeof process !== 'undefined' && process.env?.GIT_REPO_ROOT
  ? process.env.GIT_REPO_ROOT
  : '/repos';

interface AdminRepoItem {
  npub: string;
  repoName: string;
  fullPath: string;
  size: number;
  lastModified: number;
  createdAt: number;
}

/**
 * Scan filesystem for all repositories (admin view)
 */
async function scanAllRepos(): Promise<AdminRepoItem[]> {
  const repos: AdminRepoItem[] = [];
  
  if (!existsSync(repoRoot)) {
    return repos;
  }
  
  try {
    // Read all user directories
    const userDirs = await readdir(repoRoot);
    
    for (const userDir of userDirs) {
      const userPath = join(repoRoot, userDir);
      
      // Skip if not a directory or doesn't look like an npub
      if (!userDir.startsWith('npub') || userDir.length < 60) continue;
      
      try {
        const stats = await stat(userPath);
        if (!stats.isDirectory()) continue;
        
        // Read repos for this user
        const repoFiles = await readdir(userPath);
        
        for (const repoFile of repoFiles) {
          if (!repoFile.endsWith('.git')) continue;
          
          const repoName = repoFile.replace(/\.git$/, '');
          const repoPath = join(userPath, repoFile);
          
          try {
            const repoStats = await stat(repoPath);
            if (!repoStats.isDirectory()) continue;
            
            // Calculate directory size (approximate - just count files)
            let size = 0;
            try {
              const calculateSize = async (dir: string): Promise<number> => {
                let total = 0;
                const entries = await readdir(dir, { withFileTypes: true });
                for (const entry of entries) {
                  const fullPath = join(dir, entry.name);
                  if (entry.isDirectory()) {
                    if (entry.name !== '.' && entry.name !== '..') {
                      total += await calculateSize(fullPath);
                    }
                  } else {
                    try {
                      const fileStats = await stat(fullPath);
                      total += fileStats.size;
                    } catch {
                      // Ignore errors for individual files
                    }
                  }
                }
                return total;
              };
              size = await calculateSize(repoPath);
            } catch {
              // If size calculation fails, just use 0
              size = 0;
            }
            
            repos.push({
              npub: userDir,
              repoName,
              fullPath: repoPath,
              size,
              lastModified: repoStats.mtime.getTime(),
              createdAt: repoStats.birthtime.getTime() || repoStats.ctime.getTime()
            });
          } catch (err) {
            logger.warn({ error: err, repoPath }, 'Failed to stat repo');
          }
        }
      } catch (err) {
        logger.warn({ error: err, userPath }, 'Failed to read user directory');
      }
    }
  } catch (err) {
    logger.error({ error: err }, 'Failed to scan repos');
    throw err;
  }
  
  // Sort by last modified (most recent first)
  repos.sort((a, b) => b.lastModified - a.lastModified);
  
  return repos;
}

export const GET: RequestHandler = async (event) => {
  try {
    const requestContext = extractRequestContext(event);
    const userPubkeyHex = requestContext.userPubkeyHex;
    
    if (!userPubkeyHex) {
      return handleAuthorizationError('Authentication required');
    }
    
    // Check if user is admin
    if (!isAdmin(userPubkeyHex)) {
      return handleAuthorizationError('Admin access required');
    }
    
    const repos = await scanAllRepos();
    
    return json({
      repos,
      total: repos.length,
      totalSize: repos.reduce((sum, repo) => sum + repo.size, 0)
    });
  } catch (err) {
    return handleApiError(err, { operation: 'listAdminRepos' }, 'Failed to list repositories');
  }
};
