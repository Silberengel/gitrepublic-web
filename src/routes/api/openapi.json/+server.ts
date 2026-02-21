import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

// Cache the spec
let cachedSpec: any = null;

export const GET: RequestHandler = async () => {
  try {
    // Return cached spec if available
    if (cachedSpec) {
      return json(cachedSpec, {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=3600'
        }
      });
    }

    // Try to import directly first (works in most build scenarios)
    try {
      // @ts-ignore - Dynamic import for JSON
      const imported = await import('./openapi.json?raw');
      const fileContent = typeof imported.default === 'string' ? imported.default : String(imported.default || imported);
      cachedSpec = JSON.parse(fileContent);
      return json(cachedSpec, {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=3600'
        }
      });
    } catch (importErr) {
      // Fallback to file system read
      console.log('Direct import failed, trying file system read:', importErr);
    }

    // Otherwise, try reading from file system
    let specPath: string;
    let lastError: Error | null = null;

    // Try method 1: Use import.meta.url (works in most cases)
    try {
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = join(__filename, '..');
      specPath = join(__dirname, 'openapi.json');
      console.log('Trying path:', specPath);
      if (existsSync(specPath)) {
        const fileContent = readFileSync(specPath, 'utf-8');
        cachedSpec = JSON.parse(fileContent);
        return json(cachedSpec, {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=3600'
          }
        });
      }
      throw new Error(`File not found at ${specPath}`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.log('Method 1 failed:', lastError.message);
      
      // Try method 2: Use process.cwd() (fallback for production builds)
      try {
        if (typeof process !== 'undefined' && process.cwd) {
          specPath = join(process.cwd(), 'src/routes/api/openapi.json/openapi.json');
          console.log('Trying path:', specPath);
          if (existsSync(specPath)) {
            const fileContent = readFileSync(specPath, 'utf-8');
            cachedSpec = JSON.parse(fileContent);
            return json(cachedSpec, {
              headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'public, max-age=3600'
              }
            });
          }
          throw new Error(`File not found at ${specPath}`);
        } else {
          throw lastError;
        }
      } catch (err2) {
        lastError = err2 instanceof Error ? err2 : new Error(String(err2));
        console.log('Method 2 failed:', lastError.message);
        throw new Error(`Failed to locate openapi.json. Tried multiple paths. Last error: ${lastError.message}`);
      }
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error('Error reading openapi.json:', errorMessage);
    return json(
      { error: 'Failed to load OpenAPI specification', details: errorMessage },
      { status: 500 }
    );
  }
};
