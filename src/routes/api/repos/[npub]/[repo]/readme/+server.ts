/**
 * API endpoint for getting README content
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fileManager } from '$lib/services/service-registry.js';
import { createRepoGetHandler } from '$lib/utils/api-handlers.js';
import type { RepoRequestContext } from '$lib/utils/api-context.js';

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
  { operation: 'getReadme' }
);
