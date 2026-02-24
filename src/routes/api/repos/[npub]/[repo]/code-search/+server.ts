/**
 * API endpoint for code search within repositories
 * Searches file contents across repositories
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fileManager, nostrClient } from '$lib/services/service-registry.js';
import { createRepoGetHandler } from '$lib/utils/api-handlers.js';
import type { RepoRequestContext, RequestEvent } from '$lib/utils/api-context.js';
import { handleValidationError } from '$lib/utils/error-handler.js';
import { join } from 'path';
import { existsSync } from 'fs';
import logger from '$lib/services/logger.js';
import { simpleGit } from 'simple-git';
import { readFile } from 'fs/promises';

const repoRoot = typeof process !== 'undefined' && process.env?.GIT_REPO_ROOT
  ? process.env.GIT_REPO_ROOT
  : '/repos';

export interface CodeSearchResult {
  file: string;
  line: number;
  content: string;
  branch: string;
  commit?: string;
}

export const GET: RequestHandler = createRepoGetHandler(
  async (context: RepoRequestContext, event: RequestEvent) => {
    const query = event.url.searchParams.get('q');
    const branch = event.url.searchParams.get('branch') || 'HEAD';
    const limit = parseInt(event.url.searchParams.get('limit') || '100', 10);

    if (!query || query.trim().length < 2) {
      throw handleValidationError('Query must be at least 2 characters', { operation: 'codeSearch', npub: context.npub, repo: context.repo });
    }

    const repoPath = join(repoRoot, context.npub, `${context.repo}.git`);
    
    // Check if repo exists
    if (!existsSync(repoPath)) {
      logger.debug({ npub: context.npub, repo: context.repo, query }, 'Code search requested for non-existent repo');
      return json([]);
    }

    try {
      const git = simpleGit(repoPath);
      const results: CodeSearchResult[] = [];

      // For bare repositories, we need to use a worktree or search the index
      // First, try to get or create a worktree for the branch
      let worktreePath: string | null = null;
      try {
        // Get the actual branch name (resolve HEAD if needed)
        let actualBranch = branch;
        if (branch === 'HEAD') {
          try {
            const branchInfo = await git.branch(['-a']);
            actualBranch = branchInfo.current || 'main';
            // If no current branch, try common defaults
            if (!actualBranch || actualBranch === 'HEAD') {
              const allBranches = branchInfo.all.map(b => b.replace(/^remotes\/origin\//, '').replace(/^remotes\//, ''));
              actualBranch = allBranches.find(b => b === 'main') || allBranches.find(b => b === 'master') || allBranches[0] || 'main';
            }
          } catch {
            actualBranch = 'main';
          }
        }

        // Get or create worktree
        worktreePath = await fileManager.getWorktree(repoPath, actualBranch, context.npub, context.repo);
      } catch (worktreeError) {
        logger.debug({ error: worktreeError, npub: context.npub, repo: context.repo, branch }, 'Could not create worktree, trying git grep with --cached');
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
            return json([]);
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
            return json([]);
          }
          throw grepError;
        }
      } else {
        // Fallback: search in the index using git grep --cached
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

          // Use git grep with --cached to search the index
          // For bare repos, we can search a specific tree
          const gitArgs = ['grep', '-n', '-I', '--break', '--heading', searchQuery, treeRef];
          const grepOutput = await git.raw(gitArgs);
          
          if (!grepOutput || !grepOutput.trim()) {
            return json([]);
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
            return json([]);
          }
          throw grepError;
        }
      }

      return json(results);
    } catch (err) {
      logger.error({ error: err, npub: context.npub, repo: context.repo, query }, 'Error performing code search');
      throw err;
    }
  },
  { operation: 'codeSearch', requireRepoExists: false, requireRepoAccess: true }
);
