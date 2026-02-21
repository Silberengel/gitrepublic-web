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
  const attemptedPaths: string[] = [];
  let lastError: Error | null = null;

  // List of paths to try
  const pathsToTry = [
    // Method 1: process.cwd() (works in most cases)
    () => join(process.cwd(), 'docs', 'tutorial.md'),
    // Method 2: process.cwd() from build directory
    () => join(process.cwd(), '..', 'docs', 'tutorial.md'),
    // Method 3: import.meta.url - go up from route file to project root
    () => {
      const __filename = fileURLToPath(import.meta.url);
      return join(__filename, '..', '..', '..', '..', 'docs', 'tutorial.md');
    },
    // Method 4: import.meta.url - alternative path calculation
    () => {
      const __filename = fileURLToPath(import.meta.url);
      return join(__filename, '..', '..', '..', '..', '..', 'docs', 'tutorial.md');
    },
    // Method 5: Check if running from build directory
    () => join(process.cwd(), 'build', 'docs', 'tutorial.md'),
  ];

  for (const getPath of pathsToTry) {
    try {
      const filePath = getPath();
      attemptedPaths.push(filePath);
      
      if (existsSync(filePath)) {
        logger.info({ filePath }, 'Found documentation file');
        const content = await readFile(filePath, 'utf-8');
        return { content };
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // Continue to next path
    }
  }

  // All paths failed
  logger.error({ 
    error: lastError, 
    attemptedPaths,
    cwd: process.cwd(),
    importMetaUrl: import.meta.url
  }, 'Error loading documentation - all paths failed');
  
  return { content: null, error: 'Failed to load documentation' };
};
