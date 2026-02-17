/**
 * NIP-19 utilities for decoding bech32 addresses
 */

import { nip19 } from 'nostr-tools';
import type { DecodedNevent, DecodedNaddr, DecodedNote } from '../../types/nip19.js';

export interface DecodedEvent {
  type: 'nevent' | 'naddr' | 'note';
  id?: string;
  pubkey?: string;
  kind?: number;
  identifier?: string;
  relays?: string[];
}

export function decodeNostrAddress(input: string): DecodedEvent | null {
  if (!input || input.trim() === '') return null;
  
  const trimmed = input.trim();
  
  // If it's already hex (64 chars), treat as event ID
  if (/^[a-f0-9]{64}$/i.test(trimmed)) {
    return { type: 'note', id: trimmed.toLowerCase() };
  }
  
  try {
    const decoded = nip19.decode(trimmed);
    
    if (decoded.type === 'nevent') {
      const data = decoded.data as DecodedNevent['data'];
      return {
        type: 'nevent',
        id: data.id,
        pubkey: data.pubkey,
        relays: data.relays
      };
    } else if (decoded.type === 'naddr') {
      const data = decoded.data as DecodedNaddr['data'];
      return {
        type: 'naddr',
        pubkey: data.pubkey,
        kind: data.kind,
        identifier: data.identifier,
        relays: data.relays
      };
    } else if (decoded.type === 'note') {
      const data = decoded.data as DecodedNote['data'];
      return {
        type: 'note',
        id: data
      };
    }
  } catch (e) {
    // Not a valid bech32
    return null;
  }
  
  return null;
}
