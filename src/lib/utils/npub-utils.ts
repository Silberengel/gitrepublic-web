/**
 * Utility functions for working with npub (Nostr public key) encoding/decoding
 */

import { nip19 } from 'nostr-tools';

/**
 * Decode an npub to a hex pubkey
 * @param npub - The npub string to decode
 * @returns The hex pubkey, or null if invalid
 */
export function decodeNpubToHex(npub: string): string | null {
  try {
    const decoded = nip19.decode(npub);
    if (decoded.type === 'npub') {
      return decoded.data as string;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Decode an npub and return both the type and data
 * @param npub - The npub string to decode
 * @returns Object with type and hex pubkey, or null if invalid
 */
export function decodeNpub(npub: string): { type: 'npub'; data: string } | null {
  try {
    const decoded = nip19.decode(npub);
    if (decoded.type === 'npub') {
      return { type: 'npub', data: decoded.data as string };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Validate and decode npub, throwing an error if invalid
 * @param npub - The npub string to decode
 * @returns The hex pubkey
 * @throws Error if npub is invalid
 */
export function requireNpubHex(npub: string): string {
  const decoded = decodeNpub(npub);
  if (!decoded) {
    throw new Error('Invalid npub format');
  }
  return decoded.data;
}
