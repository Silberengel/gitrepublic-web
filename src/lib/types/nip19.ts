/**
 * Type definitions for NIP-19 bech32 encoded entities
 * These types help with proper typing of nip19.decode() return values
 */

/**
 * Decoded npub (public key)
 */
export interface DecodedNpub {
  type: 'npub';
  data: string; // hex pubkey
}

/**
 * Decoded nsec (private key)
 */
export interface DecodedNsec {
  type: 'nsec';
  data: Uint8Array; // private key bytes
}

/**
 * Decoded note (event ID)
 */
export interface DecodedNote {
  type: 'note';
  data: string; // hex event ID
}

/**
 * Decoded nevent (event reference)
 */
export interface DecodedNevent {
  type: 'nevent';
  data: {
    id: string; // hex event ID
    pubkey?: string; // hex pubkey
    relays?: string[]; // relay hints
    kind?: number; // event kind
  };
}

/**
 * Decoded naddr (parameterized replaceable event)
 */
export interface DecodedNaddr {
  type: 'naddr';
  data: {
    pubkey: string; // hex pubkey
    kind: number; // event kind
    identifier: string; // d-tag value
    relays?: string[]; // relay hints
  };
}

/**
 * Union type for all decoded NIP-19 entities
 */
export type DecodedNip19 = DecodedNpub | DecodedNsec | DecodedNote | DecodedNevent | DecodedNaddr;

/**
 * Type guard to check if decoded value is an npub
 */
export function isDecodedNpub(decoded: DecodedNip19): decoded is DecodedNpub {
  return decoded.type === 'npub';
}

/**
 * Type guard to check if decoded value is a nevent
 */
export function isDecodedNevent(decoded: DecodedNip19): decoded is DecodedNevent {
  return decoded.type === 'nevent';
}

/**
 * Type guard to check if decoded value is an naddr
 */
export function isDecodedNaddr(decoded: DecodedNip19): decoded is DecodedNaddr {
  return decoded.type === 'naddr';
}
