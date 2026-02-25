/**
 * Server-side loader for GitRepublic documentation
 * Dynamic route that serves any markdown file from the docs directory
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { error } from '@sveltejs/kit';
// @ts-ignore - SvelteKit generates this type
import type { PageServerLoad } from './$types';
import logger from '$lib/services/logger.js';

export const load: PageServerLoad = async ({ params }: { params: { slug: string } }) => {
  let slug = params.slug;
  
  // Security: Only allow alphanumeric, hyphens, underscores, and dots
  if (!/^[a-zA-Z0-9._-]+$/.test(slug)) {
    throw error(400, 'Invalid documentation path');
  }
  
  // Prevent path traversal
  if (slug.includes('..') || slug.includes('/')) {
    throw error(400, 'Invalid documentation path');
  }
  
  const attemptedPaths: string[] = [];
  let lastError: Error | null = null;

  // Helper function to try both exact case and lowercase versions
  const tryPaths = (basePath: string) => {
    const paths: string[] = [];
    // Try exact case first
    paths.push(join(basePath, `${slug}.md`));
    // Try lowercase version (for case-insensitive filesystems)
    if (slug !== slug.toLowerCase()) {
      paths.push(join(basePath, `${slug.toLowerCase()}.md`));
    }
    return paths;
  };

  // List of base paths to try
  const basePathsToTry = [
    // Method 1: process.cwd() (works in most cases)
    () => join(process.cwd(), 'docs'),
    // Method 2: process.cwd() from build directory
    () => join(process.cwd(), '..', 'docs'),
    // Method 3: import.meta.url - go up from route file to project root
    () => {
      const __filename = fileURLToPath(import.meta.url);
      return join(__filename, '..', '..', '..', '..', '..', 'docs');
    },
    // Method 4: import.meta.url - alternative path calculation
    () => {
      const __filename = fileURLToPath(import.meta.url);
      return join(__filename, '..', '..', '..', '..', '..', '..', 'docs');
    },
    // Method 5: Check if running from build directory
    () => join(process.cwd(), 'build', 'docs'),
  ];

  // Try all combinations of base paths and file name variations
  for (const getBasePath of basePathsToTry) {
    try {
      const basePath = getBasePath();
      const paths = tryPaths(basePath);
      
      for (const filePath of paths) {
        attemptedPaths.push(filePath);
        
        if (existsSync(filePath)) {
          logger.info({ filePath, slug }, 'Found documentation file');
          const content = await readFile(filePath, 'utf-8');
          return { content, slug };
        }
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
    slug,
    cwd: process.cwd(),
    importMetaUrl: import.meta.url
  }, 'Error loading documentation - all paths failed');
  
  throw error(404, `Documentation file "${slug}.md" not found`);
};
