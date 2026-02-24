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

      // Use git grep to search file contents
      // git grep -n -I --break --heading -i "query" branch
      // -n: show line numbers
      // -I: ignore binary files
      // --break: add blank line between matches from different files
      // --heading: show filename before matches
      // -i: case-insensitive (optional, we'll make it configurable)
      
      const searchQuery = query.trim();
      const gitArgs = ['grep', '-n', '-I', '--break', '--heading', searchQuery, branch];
      
      try {
        const grepOutput = await git.raw(gitArgs);
        
        if (!grepOutput || !grepOutput.trim()) {
          return json([]);
        }

        // Parse git grep output
        // Format:
        // filename
        // line:content
        // line:content
        // 
        // filename2
        // line:content
        
        const lines = grepOutput.split('\n');
        let currentFile = '';
        
        for (const line of lines) {
          if (!line.trim()) {
            continue; // Skip empty lines
          }
          
          // Check if this is a filename (no colon, or starts with a path)
          if (!line.includes(':') || line.startsWith('/') || line.match(/^[a-zA-Z0-9_\-./]+$/)) {
            // This might be a filename
            // Git grep with --heading shows filename on its own line
            // But we need to be careful - it could also be content with a colon
            // If it doesn't have a colon and looks like a path, it's a filename
            if (!line.includes(':')) {
              currentFile = line.trim();
              continue;
            }
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
        // git grep returns exit code 1 when no matches found, which is not an error
        if (grepError.message && grepError.message.includes('exit code 1')) {
          // No matches found, return empty array
          return json([]);
        }
        throw grepError;
      }

      return json(results);
    } catch (err) {
      logger.error({ error: err, npub: context.npub, repo: context.repo, query }, 'Error performing code search');
      throw err;
    }
  },
  { operation: 'codeSearch', requireRepoExists: false, requireRepoAccess: true }
);
