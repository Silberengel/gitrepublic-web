import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

// Cache the spec in production
let cachedSpec: any = null;

export const GET: RequestHandler = async () => {
  try {
    // Use cached spec if available (in production)
    if (cachedSpec && typeof process !== 'undefined' && process.env.NODE_ENV === 'production') {
      return json(cachedSpec, {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=3600'
        }
      });
    }
    
    // Try to read the file using different path resolution methods
    let openApiSpec: any = null;
    let lastError: Error | null = null;
    
    // Method 1: Try using fileURLToPath (works in most cases)
    try {
      const __dirname = fileURLToPath(new URL('.', import.meta.url));
      const specPath = join(__dirname, 'openapi.json');
      openApiSpec = JSON.parse(readFileSync(specPath, 'utf-8'));
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      
      // Method 2: Try using process.cwd() (fallback for build environments)
      try {
        if (typeof process !== 'undefined' && process.cwd) {
          const specPath = join(process.cwd(), 'src/routes/api/openapi.json/openapi.json');
          openApiSpec = JSON.parse(readFileSync(specPath, 'utf-8'));
        }
      } catch (err2) {
        lastError = err2 instanceof Error ? err2 : new Error(String(err2));
        
        // Method 3: Try relative to import.meta.url parent
        try {
          const __filename = fileURLToPath(import.meta.url);
          const __dirname = join(__filename, '..');
          const specPath = join(__dirname, 'openapi.json');
          openApiSpec = JSON.parse(readFileSync(specPath, 'utf-8'));
        } catch (err3) {
          lastError = err3 instanceof Error ? err3 : new Error(String(err3));
          throw new Error(`Failed to locate openapi.json file. Tried multiple paths. Last error: ${lastError.message}`);
        }
      }
    }
    
    if (!openApiSpec) {
      throw new Error('Failed to load OpenAPI specification');
    }
    
    // Cache for production
    if (typeof process !== 'undefined' && process.env.NODE_ENV === 'production') {
      cachedSpec = openApiSpec;
    }
    
    return json(openApiSpec, {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600'
      }
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error('Error reading openapi.json:', errorMessage);
    return error(500, `Failed to load OpenAPI specification: ${errorMessage}`);
  }
};
