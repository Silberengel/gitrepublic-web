import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

// Read the file dynamically to avoid Vite caching issues
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const specPath = join(__dirname, 'openapi.json');

export const GET: RequestHandler = async () => {
  // Read file fresh on each request to avoid cache issues during development
  const openApiSpec = JSON.parse(readFileSync(specPath, 'utf-8'));
  
  return json(openApiSpec, {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600'
    }
  });
};
