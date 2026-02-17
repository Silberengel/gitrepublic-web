/**
 * Tor utility functions for detecting and handling .onion addresses
 */

import { isOnionAddress, TOR_ENABLED, parseTorProxy } from '../config.js';

/**
 * Check if a URL should use Tor proxy
 */
export function shouldUseTor(url: string): boolean {
  return TOR_ENABLED && isOnionAddress(url);
}

/**
 * Get Tor SOCKS proxy configuration
 */
export function getTorProxy(): { host: string; port: number } | null {
  return parseTorProxy();
}

/**
 * Format git URL with Tor proxy configuration
 * Returns the original URL if Tor is not needed or not available
 */
export function formatGitUrlWithTor(url: string): string {
  if (!shouldUseTor(url)) {
    return url;
  }
  
  const proxy = getTorProxy();
  if (!proxy) {
    return url;
  }
  
  // Git can use Tor via GIT_PROXY_COMMAND or http.proxy
  // For now, return the original URL - git will be configured separately
  return url;
}
