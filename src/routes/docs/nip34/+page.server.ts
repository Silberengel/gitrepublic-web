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
    () => join(process.cwd(), 'docs', '34.md'),
    () => join(process.cwd(), '..', 'docs', '34.md'),
    () => {
      const __filename = fileURLToPath(import.meta.url);
      return join(__filename, '..', '..', '..', '..', 'docs', '34.md');
    },
    () => {
      const __filename = fileURLToPath(import.meta.url);
      return join(__filename, '..', '..', '..', '..', '..', 'docs', '34.md');
    },
    () => join(process.cwd(), 'build', 'docs', '34.md'),
  ];

  for (const getPath of pathsToTry) {
    try {
      const filePath = getPath();
      attemptedPaths.push(filePath);
      
      if (existsSync(filePath)) {
        logger.info({ filePath }, 'Found NIP-34 documentation file');
        const content = await readFile(filePath, 'utf-8');
        return { content };
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  logger.error({ 
    error: lastError, 
    attemptedPaths,
    cwd: process.cwd(),
    importMetaUrl: import.meta.url
  }, 'Error loading NIP-34 documentation - all paths failed');
  
  return { content: null, error: 'Failed to load NIP-34 documentation' };
};
