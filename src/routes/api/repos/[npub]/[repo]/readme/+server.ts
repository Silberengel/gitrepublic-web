/**
 * API endpoint for getting README content
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fileManager, repoManager, nostrClient } from '$lib/services/service-registry.js';
import { createRepoGetHandler } from '$lib/utils/api-handlers.js';
import type { RepoRequestContext } from '$lib/utils/api-context.js';
import { handleApiError } from '$lib/utils/error-handler.js';
import { KIND } from '$lib/types/nostr.js';
import { join } from 'path';
import { existsSync } from 'fs';

const repoRoot = typeof process !== 'undefined' && process.env?.GIT_REPO_ROOT
  ? process.env.GIT_REPO_ROOT
  : '/repos';

const README_PATTERNS = [
  'README.md',
  'README.markdown',
  'README.txt',
  'readme.md',
  'readme.markdown',
  'readme.txt',
  'README',
  'readme'
];

export const GET: RequestHandler = createRepoGetHandler(
  async (context: RepoRequestContext) => {
    const repoPath = join(repoRoot, context.npub, `${context.repo}.git`);
    
    // If repo doesn't exist, try to fetch it on-demand
    if (!existsSync(repoPath)) {
      try {
        // Fetch repository announcement from Nostr
        const events = await nostrClient.fetchEvents([
          {
            kinds: [KIND.REPO_ANNOUNCEMENT],
            authors: [context.repoOwnerPubkey],
            '#d': [context.repo],
            limit: 1
          }
        ]);

        if (events.length > 0) {
          // Try to fetch the repository from remote clone URLs
          const fetched = await repoManager.fetchRepoOnDemand(
            context.npub,
            context.repo,
            events[0]
          );
          
          if (!fetched) {
            // If fetch fails, return not found (readme endpoint is non-critical)
            return json({ found: false });
          }
        } else {
          // No announcement found, return not found
          return json({ found: false });
        }
      } catch (err) {
        // If fetching fails, return not found (readme is optional)
        return json({ found: false });
      }
    }

    const ref = context.ref || 'HEAD';
    
    // Try to find README file
    let readmeContent: string | null = null;
    let readmePath: string | null = null;

    for (const pattern of README_PATTERNS) {
      try {
        // Try root directory first
        const content = await fileManager.getFileContent(context.npub, context.repo, pattern, ref);
        readmeContent = content.content;
        readmePath = pattern;
        break;
      } catch {
        // Try in root directory with different paths
        try {
          const content = await fileManager.getFileContent(context.npub, context.repo, `/${pattern}`, ref);
          readmeContent = content.content;
          readmePath = `/${pattern}`;
          break;
        } catch {
          continue;
        }
      }
    }

    if (!readmeContent) {
      return json({ found: false });
    }

    return json({
      found: true,
      content: readmeContent,
      path: readmePath,
      isMarkdown: readmePath?.toLowerCase().endsWith('.md') || readmePath?.toLowerCase().endsWith('.markdown')
    });
  },
  { operation: 'getReadme', requireRepoExists: false, requireRepoAccess: false } // Handle on-demand fetching, readme is public
);
