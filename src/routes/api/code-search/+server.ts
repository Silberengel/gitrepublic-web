/**
 * API endpoint for global code search across all repositories
 * Searches file contents across multiple repositories
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { handleValidationError } from '$lib/utils/error-handler.js';
import { extractRequestContext } from '$lib/utils/api-context.js';
import { DEFAULT_NOSTR_RELAYS } from '$lib/config.js';
import { NostrClient } from '$lib/services/nostr/nostr-client.js';
import { KIND } from '$lib/types/nostr.js';
import { eventCache } from '$lib/services/nostr/event-cache.js';
import { fetchRepoAnnouncementsWithCache } from '$lib/utils/nostr-utils.js';
import logger from '$lib/services/logger.js';
import { readdir, stat } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { simpleGit } from 'simple-git';
import { fileManager } from '$lib/services/service-registry.js';

const repoRoot = typeof process !== 'undefined' && process.env?.GIT_REPO_ROOT
  ? process.env.GIT_REPO_ROOT
  : '/repos';

export interface GlobalCodeSearchResult {
  repo: string;
  npub: string;
  file: string;
  line: number;
  content: string;
  branch: string;
}

export const GET: RequestHandler = async (event) => {
  const query = event.url.searchParams.get('q');
  const repoFilter = event.url.searchParams.get('repo'); // Optional: filter by specific repo (npub/repo format)
  const limit = parseInt(event.url.searchParams.get('limit') || '100', 10);

  if (!query || query.trim().length < 2) {
    throw handleValidationError('Query must be at least 2 characters', { operation: 'globalCodeSearch' });
  }

  const requestContext = extractRequestContext(event);
  const results: GlobalCodeSearchResult[] = [];

  try {
    // If repo filter is specified, search only that repo
    if (repoFilter) {
      const [npub, repo] = repoFilter.split('/');
      if (npub && repo) {
        const repoPath = join(repoRoot, npub, `${repo}.git`);
        if (existsSync(repoPath)) {
          const repoResults = await searchInRepo(npub, repo, query, limit);
          results.push(...repoResults);
        }
      }
      return json(results);
    }

    // Search across all repositories
    // First, get list of all repos from filesystem
    if (!existsSync(repoRoot)) {
      return json([]);
    }

    const users = await readdir(repoRoot);
    
    for (const user of users) {
      const userPath = join(repoRoot, user);
      const userStat = await stat(userPath);
      
      if (!userStat.isDirectory()) {
        continue;
      }

      const repos = await readdir(userPath);
      
      for (const repo of repos) {
        if (!repo.endsWith('.git')) {
          continue;
        }

        const repoName = repo.replace(/\.git$/, '');
        const repoPath = join(userPath, repo);
        const repoStat = await stat(repoPath);
        
        if (!repoStat.isDirectory()) {
          continue;
        }

        // Check access for private repos
        try {
          const { MaintainerService } = await import('$lib/services/nostr/maintainer-service.js');
          const maintainerService = new MaintainerService(DEFAULT_NOSTR_RELAYS);
          
          // Decode npub to hex
          const { nip19 } = await import('nostr-tools');
          let repoOwnerPubkey: string;
          try {
            const decoded = nip19.decode(user);
            if (decoded.type === 'npub') {
              repoOwnerPubkey = decoded.data as string;
            } else {
              repoOwnerPubkey = user; // Assume it's already hex
            }
          } catch {
            repoOwnerPubkey = user; // Assume it's already hex
          }

          const canView = await maintainerService.canView(
            requestContext.userPubkeyHex || null,
            repoOwnerPubkey,
            repoName
          );

          if (!canView) {
            continue; // Skip private repos user can't access
          }
        } catch (accessErr) {
          logger.debug({ error: accessErr, user, repo: repoName }, 'Error checking access, skipping repo');
          continue;
        }

        // Search in this repo
        try {
          const repoResults = await searchInRepo(user, repoName, query, limit - results.length);
          results.push(...repoResults);
          
          if (results.length >= limit) {
            break;
          }
        } catch (searchErr) {
          logger.debug({ error: searchErr, user, repo: repoName }, 'Error searching repo, continuing');
          continue;
        }
      }

      if (results.length >= limit) {
        break;
      }
    }

    return json(results.slice(0, limit));
  } catch (err) {
    logger.error({ error: err, query }, 'Error performing global code search');
    throw err;
  }
};

async function searchInRepo(
  npub: string,
  repo: string,
  query: string,
  limit: number
): Promise<GlobalCodeSearchResult[]> {
  const repoPath = join(repoRoot, npub, `${repo}.git`);
  
  if (!existsSync(repoPath)) {
    return [];
  }

  const results: GlobalCodeSearchResult[] = [];
  const git = simpleGit(repoPath);
  
  try {
    // Get default branch
    let branch = 'HEAD';
    try {
      const branches = await git.branchLocal();
      branch = branches.current || 'HEAD';
      // If no current branch, try common defaults
      if (!branch || branch === 'HEAD') {
        const allBranches = branches.all.map(b => b.replace(/^remotes\/origin\//, '').replace(/^remotes\//, ''));
        branch = allBranches.find(b => b === 'main') || allBranches.find(b => b === 'master') || allBranches[0] || 'main';
      }
    } catch {
      branch = 'main';
    }

    // For bare repositories, we need to use a worktree or search the index
    let worktreePath: string | null = null;
    try {
      // Get the actual branch name (resolve HEAD if needed)
      let actualBranch = branch;
      if (branch === 'HEAD') {
        actualBranch = 'main';
      }

      // Get or create worktree
      worktreePath = await fileManager.getWorktree(repoPath, actualBranch, npub, repo);
    } catch (worktreeError) {
      logger.debug({ error: worktreeError, npub, repo, branch }, 'Could not create worktree, trying git grep with tree reference');
      // Fall back to searching the index
    }

    const searchQuery = query.trim();
    
    // If we have a worktree, search in the worktree
    if (worktreePath && existsSync(worktreePath)) {
      try {
        const worktreeGit = simpleGit(worktreePath);
        const gitArgs = ['grep', '-n', '-I', '--break', '--heading', searchQuery];
        const grepOutput = await worktreeGit.raw(gitArgs);
        
        if (!grepOutput || !grepOutput.trim()) {
          return [];
        }

        // Parse git grep output
        const lines = grepOutput.split('\n');
        let currentFile = '';
        
        for (const line of lines) {
          if (!line.trim()) {
            continue;
          }
          
          // Check if this is a filename (no colon)
          if (!line.includes(':')) {
            currentFile = line.trim();
            continue;
          }
          
          // Parse line:content format
          const colonIndex = line.indexOf(':');
          if (colonIndex > 0 && currentFile) {
            const lineNumber = parseInt(line.substring(0, colonIndex), 10);
            const content = line.substring(colonIndex + 1);
            
            if (!isNaN(lineNumber) && content) {
              // Make file path relative to repo root
              const relativeFile = currentFile.replace(worktreePath + '/', '').replace(/^\.\//, '');
              results.push({
                repo,
                npub,
                file: relativeFile,
                line: lineNumber,
                content: content.trim(),
                branch: branch === 'HEAD' ? 'HEAD' : branch
              });
              
              if (results.length >= limit) {
                break;
              }
            }
          }
        }
      } catch (grepError: any) {
        // git grep returns exit code 1 when no matches found
        if (grepError.message && grepError.message.includes('exit code 1')) {
          return [];
        }
        throw grepError;
      }
    } else {
      // Fallback: search in the index using git grep with tree reference
      try {
        // Get the tree for the branch
        let treeRef = branch;
        if (branch === 'HEAD') {
          try {
            const branchInfo = await git.branch(['-a']);
            treeRef = branchInfo.current || 'HEAD';
          } catch {
            treeRef = 'HEAD';
          }
        }

        // Use git grep with tree reference for bare repos
        const gitArgs = ['grep', '-n', '-I', '--break', '--heading', searchQuery, treeRef];
        const grepOutput = await git.raw(gitArgs);
        
        if (!grepOutput || !grepOutput.trim()) {
          return [];
        }

        // Parse git grep output
        const lines = grepOutput.split('\n');
        let currentFile = '';
        
        for (const line of lines) {
          if (!line.trim()) {
            continue;
          }
          
          // Check if this is a filename (no colon)
          if (!line.includes(':')) {
            currentFile = line.trim();
            continue;
          }
          
          // Parse line:content format
          const colonIndex = line.indexOf(':');
          if (colonIndex > 0 && currentFile) {
            const lineNumber = parseInt(line.substring(0, colonIndex), 10);
            const content = line.substring(colonIndex + 1);
            
            if (!isNaN(lineNumber) && content) {
              results.push({
                repo,
                npub,
                file: currentFile,
                line: lineNumber,
                content: content.trim(),
                branch: branch === 'HEAD' ? 'HEAD' : branch
              });
              
              if (results.length >= limit) {
                break;
              }
            }
          }
        }
      } catch (grepError: any) {
        // git grep returns exit code 1 when no matches found
        if (grepError.message && grepError.message.includes('exit code 1')) {
          return [];
        }
        throw grepError;
      }
    }
  } catch (err) {
    logger.debug({ error: err, npub, repo, query }, 'Error searching in repo');
    return [];
  }

  return results;
}
