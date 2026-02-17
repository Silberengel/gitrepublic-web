/**
 * API endpoint to get the Tor .onion address for the server
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getTorOnionAddress } from '$lib/services/tor/hidden-service.js';

export const GET: RequestHandler = async () => {
  const onion = await getTorOnionAddress();
  return json({ onion, available: onion !== null });
};
