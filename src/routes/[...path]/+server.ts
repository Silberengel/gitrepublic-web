/**
 * Catch-all route to handle .md files at root level
 * Redirects /nostr-integration.md -> /docs/nostr-integration
 * 
 * Note: This route only handles .md files. Other routes take precedence.
 */

import { redirect, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
  const path = params.path;
  
  // Only handle .md files - return 404 for everything else
  if (!path || !path.endsWith('.md')) {
    throw error(404, 'Not found');
  }
  
  // Extract filename without .md extension
  const filename = path.replace(/\.md$/, '');
  
  // Security: Only allow alphanumeric, hyphens, underscores
  if (!/^[a-zA-Z0-9_-]+$/.test(filename)) {
    throw error(400, 'Invalid documentation path');
  }
  
  // Redirect to docs route
  throw redirect(302, `/docs/${filename}`);
};
