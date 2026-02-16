/**
 * Server-side hooks for gitrepublic-web
 * Initializes repo polling service
 */

import type { Handle } from '@sveltejs/kit';
import { RepoPollingService } from './lib/services/nostr/repo-polling.js';
import { GIT_DOMAIN } from './lib/config.js';

// Initialize polling service
const relays = (process.env.NOSTR_RELAYS || 'wss://theforest.nostr1.com,wss://nostr.land,wss://relay.damus.io').split(',');
const repoRoot = process.env.GIT_REPO_ROOT || '/repos';
const domain = GIT_DOMAIN;

let pollingService: RepoPollingService | null = null;

if (typeof process !== 'undefined') {
  pollingService = new RepoPollingService(relays, repoRoot, domain);
  pollingService.start();
  console.log('Started repo polling service');
}

export const handle: Handle = async ({ event, resolve }) => {
  return resolve(event);
};
