/**
 * Server-side loader for GitRepublic documentation
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import type { PageServerLoad } from './$types';
import logger from '$lib/services/logger.js';

export const load: PageServerLoad = async () => {
  try {
    // Read tutorial documentation from docs/tutorial.md
    const filePath = join(process.cwd(), 'docs', 'tutorial.md');
    const content = await readFile(filePath, 'utf-8');
    return { content };
  } catch (error) {
    logger.error({ error }, 'Error loading documentation');
    return { content: null, error: 'Failed to load documentation' };
  }
};
