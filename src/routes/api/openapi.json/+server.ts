import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import openApiSpec from './openapi.json';

export const GET: RequestHandler = async () => {
  return json(openApiSpec, {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600'
    }
  });
};
