/**
 * Tor Hidden Service management
 * Detects and provides .onion addresses for the server
 */

import { readFile, access } from 'fs/promises';
import { constants } from 'fs';
import { join } from 'path';
import logger from '../logger.js';
import { TOR_ENABLED } from '../../config.js';

/**
 * Common locations for Tor hidden service hostname files
 */
const TOR_HOSTNAME_PATHS = [
  '/var/lib/tor/hidden_service/hostname',
  '/var/lib/tor/gitrepublic/hostname',
  '/usr/local/var/lib/tor/hidden_service/hostname',
  '/home/.tor/hidden_service/hostname',
  process.env.TOR_HOSTNAME_FILE || ''
].filter(Boolean);

/**
 * Get the Tor hidden service .onion address
 * Returns null if Tor is not enabled or .onion address cannot be found
 */
export async function getTorOnionAddress(): Promise<string | null> {
  if (!TOR_ENABLED) {
    return null;
  }

  // First, check if explicitly set via environment variable
  if (typeof process !== 'undefined' && process.env?.TOR_ONION_ADDRESS) {
    const onion = process.env.TOR_ONION_ADDRESS.trim();
    if (onion.endsWith('.onion')) {
      logger.info({ onion }, 'Using Tor .onion address from environment variable');
      return onion;
    }
  }

  // Try to read from Tor hidden service hostname file
  for (const hostnamePath of TOR_HOSTNAME_PATHS) {
    if (!hostnamePath) continue;
    
    try {
      await access(hostnamePath, constants.R_OK);
      const hostname = await readFile(hostnamePath, 'utf-8');
      const onion = hostname.trim().split('\n')[0].trim();
      
      if (onion.endsWith('.onion')) {
        logger.info({ onion, path: hostnamePath }, 'Found Tor .onion address from hostname file');
        return onion;
      }
    } catch {
      // File doesn't exist or can't be read, try next path
      continue;
    }
  }

  logger.warn('Tor is enabled but .onion address not found. Set TOR_ONION_ADDRESS env var or configure Tor hidden service.');
  return null;
}

/**
 * Get the full git URL with Tor .onion address for a repository
 */
export async function getTorGitUrl(npub: string, repoName: string): Promise<string | null> {
  const onion = await getTorOnionAddress();
  if (!onion) {
    return null;
  }

  // Use HTTP for .onion addresses (HTTPS doesn't work with .onion)
  return `http://${onion}/${npub}/${repoName}.git`;
}

/**
 * Check if Tor hidden service is available
 */
export async function isTorHiddenServiceAvailable(): Promise<boolean> {
  const onion = await getTorOnionAddress();
  return onion !== null;
}
