/**
 * Server-side loader for NIP-34 documentation
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
  try {
    // Read NIP-34.md from the project root
    const filePath = join(process.cwd(), 'NIP-34.md');
    const content = await readFile(filePath, 'utf-8');
    return { content };
  } catch (error) {
    console.error('Error loading NIP-34.md:', error);
    return { content: null, error: 'Failed to load documentation' };
  }
};
