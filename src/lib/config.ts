/**
 * Application configuration
 * Centralized config that can be overridden by environment variables
 */

/**
 * Git domain for repository URLs
 * Defaults to localhost:6543, can be overridden by GIT_DOMAIN env var
 */
export const GIT_DOMAIN = 
  typeof process !== 'undefined' && process.env?.GIT_DOMAIN
    ? process.env.GIT_DOMAIN
    : 'localhost:6543';

/**
 * Default Nostr relays to use
 * Can be overridden by NOSTR_RELAYS env var (comma-separated list)
 */
export const DEFAULT_NOSTR_RELAYS = 
  typeof process !== 'undefined' && process.env?.NOSTR_RELAYS
    ? process.env.NOSTR_RELAYS.split(',').map(r => r.trim()).filter(r => r.length > 0)
    : [
        'wss://theforest.nostr1.com',
        'wss://nostr.land',
        'wss://relay.damus.io'
      ];

/**
 * Get the full git URL for a repository
 */
export function getGitUrl(npub: string, repoName: string): string {
  const protocol = GIT_DOMAIN.startsWith('localhost') ? 'http' : 'https';
  return `${protocol}://${GIT_DOMAIN}/${npub}/${repoName}.git`;
}

/**
 * Combine default relays with user's relays (from kind 10002)
 * Returns a deduplicated list with user relays first, then defaults
 */
export function combineRelays(userRelays: string[] = [], defaultRelays: string[] = DEFAULT_NOSTR_RELAYS): string[] {
  // Combine user relays with defaults, removing duplicates
  // User relays come first to prioritize them
  const combined = [...userRelays, ...defaultRelays];
  return [...new Set(combined)];
}
