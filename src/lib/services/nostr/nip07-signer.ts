/**
 * NIP-07 browser extension signer
 */

import type { NostrEvent } from '../../types/nostr.js';

declare global {
  interface Window {
    nostr?: {
      getPublicKey(): Promise<string>;
      signEvent(event: Omit<NostrEvent, 'sig' | 'id'>): Promise<NostrEvent>;
    };
  }
}

export function isNIP07Available(): boolean {
  return typeof window !== 'undefined' && typeof window.nostr !== 'undefined';
}

export async function getPublicKeyWithNIP07(): Promise<string> {
  if (!isNIP07Available()) {
    throw new Error('NIP-07 extension not available');
  }
  return await window.nostr!.getPublicKey();
}

export async function signEventWithNIP07(event: Omit<NostrEvent, 'sig' | 'id'>): Promise<NostrEvent> {
  if (!isNIP07Available()) {
    throw new Error('NIP-07 extension not available');
  }
  return await window.nostr!.signEvent(event);
}
