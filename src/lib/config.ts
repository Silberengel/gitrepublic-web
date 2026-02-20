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
 * Default Nostr relays to use for operations (publishing, fetching)
 * Can be overridden by NOSTR_RELAYS env var (comma-separated list)
 * 
 */
export const DEFAULT_NOSTR_RELAYS = 
  typeof process !== 'undefined' && process.env?.NOSTR_RELAYS
    ? process.env.NOSTR_RELAYS.split(',').map(r => r.trim()).filter(r => r.length > 0)
    : [
        'wss://theforest.nostr1.com',
        'wss://nostr.land',
      ];

/**
 * Nostr relays to use for searching for repositories, profiles, or other events
 * Can be overridden by NOSTR_SEARCH_RELAYS env var (comma-separated list)
 * 
 */
export const DEFAULT_NOSTR_SEARCH_RELAYS = 
  typeof process !== 'undefined' && process.env?.NOSTR_SEARCH_RELAYS
    ? process.env.NOSTR_SEARCH_RELAYS.split(',').map(r => r.trim()).filter(r => r.length > 0)
    : [
      'wss://theforest.nostr1.com',
      'wss://nostr.land',
      'wss://relay.damus.io',
      'wss://thecitadel.nostr1.com',
      'wss://nostr21.com',
      'wss://relay.primal.net',

      ];

/**
 * Get the full git URL for a repository
 */
export function getGitUrl(npub: string, repoName: string): string {
  const protocol = GIT_DOMAIN.startsWith('localhost') ? 'http' : 'https';
  return `${protocol}://${GIT_DOMAIN}/${npub}/${repoName}.git`;
}

/**
 * Tor SOCKS proxy configuration
 * Defaults to localhost:9050 (standard Tor SOCKS port)
 * Can be overridden by TOR_SOCKS_PROXY env var (format: host:port)
 * Set to empty string to disable Tor support
 */
export const TOR_SOCKS_PROXY = 
  typeof process !== 'undefined' && process.env?.TOR_SOCKS_PROXY !== undefined
    ? process.env.TOR_SOCKS_PROXY.trim()
    : '127.0.0.1:9050';

export const TOR_ENABLED = TOR_SOCKS_PROXY !== '';

/**
 * Parse Tor SOCKS proxy into host and port
 */
export function parseTorProxy(): { host: string; port: number } | null {
  if (!TOR_ENABLED) return null;
  
  const [host, portStr] = TOR_SOCKS_PROXY.split(':');
  const port = parseInt(portStr || '9050', 10);
  
  if (!host || isNaN(port)) {
    return null;
  }
  
  return { host, port };
}

/**
 * Check if a URL is a .onion address
 */
export function isOnionAddress(url: string): boolean {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.endsWith('.onion');
  } catch {
    // If URL parsing fails, check if it contains .onion
    return url.includes('.onion');
  }
}

/**
 * Enterprise mode configuration
 * When enabled, the system expects to run in Kubernetes with container-per-tenant architecture
 * Default: false (lightweight mode - single container)
 * Can be overridden by ENTERPRISE_MODE env var (set to "true" to enable)
 */
export const ENTERPRISE_MODE = 
  typeof process !== 'undefined' && process.env?.ENTERPRISE_MODE === 'true';

/**
 * Security mode string (for logging/debugging)
 */
export const SECURITY_MODE = ENTERPRISE_MODE ? 'enterprise' : 'lightweight';

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
