/**
 * Server-side loader for NIP-34 documentation
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import type { PageServerLoad } from './$types';
import logger from '$lib/services/logger.js';

export const load: PageServerLoad = async () => {
  try {
    // Read NIP-34.md from the project root
    const filePath = join(process.cwd(), 'NIP-34.md');
    const content = await readFile(filePath, 'utf-8');
    return { content };
  } catch (error) {
    logger.error({ error }, 'Error loading NIP-34.md');
    return { content: null, error: 'Failed to load documentation' };
  }
};
