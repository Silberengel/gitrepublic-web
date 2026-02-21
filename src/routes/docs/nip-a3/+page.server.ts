/**
 * Server-side loader for NIP-A3 documentation
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import type { PageServerLoad } from './$types';
import logger from '$lib/services/logger.js';

export const load: PageServerLoad = async () => {
  try {
    // Read NIP-A3 documentation from docs/NIP-A3.md
    const filePath = join(process.cwd(), 'docs', 'NIP-A3.md');
    const content = await readFile(filePath, 'utf-8');
    return { content };
  } catch (error) {
    logger.error({ error }, 'Error loading NIP-A3 documentation');
    return { content: null, error: 'Failed to load NIP-A3 documentation' };
  }
};
