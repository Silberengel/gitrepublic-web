/**
 * Root layout server load function
 * Provides config to all pages
 */

import { GIT_DOMAIN } from '$lib/config.js';

export async function load() {
  return {
    gitDomain: GIT_DOMAIN
  };
}
