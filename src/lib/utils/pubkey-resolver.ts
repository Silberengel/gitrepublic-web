/**
 * Utility to resolve various pubkey formats to hex pubkey
 * Supports: hex pubkey, npub, nprofile, NIP-05
 */

import { nip19 } from 'nostr-tools';
import logger from '../services/logger.js';

/**
 * Resolve a pubkey from various formats to hex
 * Supports:
 * - Hex pubkey (64 hex characters)
 * - npub (NIP-19 encoded pubkey)
 * - nprofile (NIP-19 encoded profile with relays)
 * - NIP-05 (e.g., user@domain.com)
 */
export async function resolvePubkey(input: string): Promise<string | null> {
  if (!input || !input.trim()) {
    return null;
  }

  const trimmed = input.trim();

  // Check if it's already a hex pubkey (64 hex characters)
  if (/^[0-9a-f]{64}$/i.test(trimmed)) {
    return trimmed.toLowerCase();
  }

  // Check if it's a NIP-19 encoded value (npub or nprofile)
  if (trimmed.startsWith('npub') || trimmed.startsWith('nprofile')) {
    try {
      const decoded = nip19.decode(trimmed);
      if (decoded.type === 'npub') {
        return decoded.data as string;
      } else if (decoded.type === 'nprofile') {
        // nprofile contains pubkey in data.pubkey
        return (decoded.data as { pubkey: string }).pubkey;
      }
    } catch (error) {
      logger.debug({ error, input: trimmed }, 'Failed to decode NIP-19 value');
      return null;
    }
  }

  // Check if it's a NIP-05 identifier (e.g., user@domain.com)
  if (trimmed.includes('@')) {
    try {
      const pubkey = await resolveNIP05(trimmed);
      return pubkey;
    } catch (error) {
      logger.debug({ error, input: trimmed }, 'Failed to resolve NIP-05');
      return null;
    }
  }

  return null;
}

/**
 * Resolve NIP-05 identifier to hex pubkey
 * Fetches from https://<domain>/.well-known/nostr.json?name=<local-part>
 */
async function resolveNIP05(nip05: string): Promise<string | null> {
  const [localPart, domain] = nip05.split('@');
  
  if (!localPart || !domain) {
    return null;
  }

  try {
    // Fetch from well-known endpoint
    const url = `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(localPart)}`;
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    
    // NIP-05 format: { "names": { "<local-part>": "<hex-pubkey>" } }
    if (data.names && data.names[localPart]) {
      const pubkey = data.names[localPart];
      // Validate it's a hex pubkey
      if (/^[0-9a-f]{64}$/i.test(pubkey)) {
        return pubkey.toLowerCase();
      }
    }

    return null;
  } catch (error) {
    logger.debug({ error, nip05 }, 'Error fetching NIP-05');
    return null;
  }
}
