/**
 * Server-side loader for GitRepublic documentation
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import type { PageServerLoad } from './$types';
import logger from '$lib/services/logger.js';

export const load: PageServerLoad = async () => {
  try {
    let filePath: string = '';
    let lastError: Error | null = null;

    // Try method 1: Use process.cwd() (works in most cases)
    try {
      filePath = join(process.cwd(), 'docs', 'tutorial.md');
      if (existsSync(filePath)) {
        const content = await readFile(filePath, 'utf-8');
        return { content };
      }
      throw new Error(`File not found at ${filePath}`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      
      // Try method 2: Use import.meta.url to find project root
      try {
        // Get the directory of this file, then go up to project root
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = join(__filename, '..', '..', '..', '..');
        filePath = join(__dirname, 'docs', 'tutorial.md');
        if (existsSync(filePath)) {
          const content = await readFile(filePath, 'utf-8');
          return { content };
        }
        throw new Error(`File not found at ${filePath}`);
      } catch (err2) {
        lastError = err2 instanceof Error ? err2 : new Error(String(err2));
        const attemptedPath = filePath || 'unknown';
        logger.error({ error: lastError, attemptedPaths: [attemptedPath] }, 'Error loading documentation');
        return { content: null, error: 'Failed to load documentation' };
      }
    }
  } catch (error) {
    logger.error({ error }, 'Error loading documentation');
    return { content: null, error: 'Failed to load documentation' };
  }
};
