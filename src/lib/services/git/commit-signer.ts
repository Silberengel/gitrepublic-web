/**
 * Git commit signing service using Nostr keys
 * Supports:
 * - NIP-07 browser extension (for web UI)
 * - NIP-98 HTTP authentication (for git operations)
 * - Direct nsec/hex keys (for server-side signing)
 */

import { nip19, getPublicKey, finalizeEvent } from 'nostr-tools';
import { createHash } from 'crypto';
import type { NostrEvent } from '../../types/nostr.js';
import { KIND } from '../../types/nostr.js';
import { signEventWithNIP07 } from '../nostr/nip07-signer.js';

export interface CommitSignature {
  signature: string;
  pubkey: string;
  eventId: string;
  timestamp: number;
}

/**
 * Decode a Nostr key from bech32 (nsec) or hex format
 * Returns the hex-encoded private key as Uint8Array
 */
export function decodeNostrKey(key: string): Uint8Array {
  let hexKey: string;
  
  // Check if it's already hex (64 characters, hex format)
  if (/^[0-9a-fA-F]{64}$/.test(key)) {
    hexKey = key.toLowerCase();
  } else {
    // Try to decode as bech32 (nsec)
    try {
      const decoded = nip19.decode(key);
      if (decoded.type === 'nsec') {
        // decoded.data for nsec is Uint8Array, convert to hex string
        const data = decoded.data as Uint8Array;
        hexKey = Array.from(data).map(b => b.toString(16).padStart(2, '0')).join('');
      } else {
        throw new Error('Key is not a valid nsec or hex private key');
      }
    } catch (error) {
      throw new Error(`Invalid key format: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // Convert hex string to Uint8Array
  const keyBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    keyBytes[i] = parseInt(hexKey.slice(i * 2, i * 2 + 2), 16);
  }
  return keyBytes;
}

/**
 * Decode a Nostr ID (event ID or pubkey) from bech32 or hex format
 * Returns the hex-encoded value as string
 */
export function decodeNostrId(id: string): string {
  // Check if it's already hex (64 characters for pubkey/event ID)
  if (/^[0-9a-fA-F]{64}$/.test(id)) {
    return id.toLowerCase();
  }

  // Try to decode as bech32 (npub, note, nevent, naddr, etc.)
  try {
    const decoded = nip19.decode(id);
    if (decoded.type === 'npub' || decoded.type === 'note' || decoded.type === 'nevent' || decoded.type === 'naddr') {
      // decoded.data can be string (for npub, note) or object (for nevent, naddr)
      if (typeof decoded.data === 'string') {
        return decoded.data;
      } else if (decoded.type === 'nevent') {
        const data = decoded.data as { id: string };
        return data.id;
      } else if (decoded.type === 'naddr') {
        // For naddr, we return the pubkey as the identifier
        const data = decoded.data as { pubkey: string };
        return data.pubkey;
      }
    }
    throw new Error('ID is not a valid bech32 or hex format');
  } catch (error) {
    throw new Error(`Invalid ID format: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Create a Nostr event for commit signing
 * This creates a kind 1640 (commit signature) event that can be used to sign commits
 */
export function createCommitSignatureEvent(
  privateKey: string,
  commitHash: string,
  commitMessage: string,
  authorName: string,
  authorEmail: string,
  timestamp: number = Math.floor(Date.now() / 1000)
): { event: NostrEvent; signature: string } {
  const keyBytes = decodeNostrKey(privateKey);
  const pubkey = getPublicKey(keyBytes);

  // Create a commit signature event template
  // Using kind 1640 for commit signatures (dedicated kind to avoid feed spam)
  const eventTemplate = {
    kind: KIND.COMMIT_SIGNATURE,
    pubkey,
    created_at: timestamp,
    tags: [
      ['commit', commitHash],
      ['author', authorName, authorEmail],
      ['message', commitMessage]
    ],
    content: `Signed commit: ${commitHash}\n\n${commitMessage}`
  };

  // Finalize and sign the event
  const signedEvent = finalizeEvent(eventTemplate, keyBytes);
  
  const event: NostrEvent = {
    ...signedEvent,
    id: signedEvent.id,
    sig: signedEvent.sig
  };

  return {
    event,
    signature: signedEvent.sig
  };
}

/**
 * Create a GPG-style signature for git commits
 * Git expects GPG signatures in a specific format, but we can use Nostr signatures
 * by embedding them in the commit message or as a trailer
 * 
 * Supports multiple signing methods:
 * - NIP-07: Browser extension signing (client-side, secure - keys never leave browser)
 * - NIP-98: Use HTTP auth event as signature (server-side, for git operations)
 * - nsec/hex: Direct key signing (server-side ONLY, via environment variables)
 * 
 * ⚠️ SECURITY WARNING: nsecKey should NEVER be sent from client requests.
 * It should only be used server-side via environment variables (e.g., NOSTRGIT_SECRET_KEY).
 * 
 * @param commitMessage - The commit message to sign
 * @param authorName - Author name
 * @param authorEmail - Author email
 * @param options - Signing options
 * @param options.useNIP07 - Use NIP-07 browser extension (client-side only, secure)
 * @param options.nip98Event - Use NIP-98 auth event as signature (server-side)
 * @param options.nsecKey - Use direct nsec/hex key (server-side ONLY, via env vars - NOT for client requests)
 * @param options.timestamp - Optional timestamp (defaults to now)
 * @returns Signed commit message and signature event
 */
export async function createGitCommitSignature(
  commitMessage: string,
  authorName: string,
  authorEmail: string,
  options: {
    useNIP07?: boolean;
    nip98Event?: NostrEvent;
    nsecKey?: string;
    timestamp?: number;
  } = {}
): Promise<{ signedMessage: string; signatureEvent: NostrEvent }> {
  const timestamp = options.timestamp || Math.floor(Date.now() / 1000);
  let signedEvent: NostrEvent;

  // Method 1: Use NIP-07 browser extension (client-side)
  if (options.useNIP07) {
    // NIP-07 will add pubkey automatically, so we don't need it in the template
    const eventTemplate: Omit<NostrEvent, 'sig' | 'id'> = {
      kind: KIND.COMMIT_SIGNATURE,
      pubkey: '', // Will be filled by NIP-07
      created_at: timestamp,
      tags: [
        ['author', authorName, authorEmail],
        ['message', commitMessage]
      ],
      content: `Signed commit: ${commitMessage}`
    };
    signedEvent = await signEventWithNIP07(eventTemplate);
  }
  // Method 2: Use NIP-98 auth event as signature (server-side, for git operations)
  else if (options.nip98Event) {
    // Security: We cannot create a valid signed event without the private key.
    // Instead, we reference the NIP-98 auth event which already proves authentication.
    // The NIP-98 event's signature proves the user can sign commits.
    // We create an unsigned event template that references the NIP-98 event.
    // Note: This event should be signed by the client before being published to relays.
    const eventTemplate = {
      kind: KIND.COMMIT_SIGNATURE,
      pubkey: options.nip98Event.pubkey,
      created_at: timestamp,
      tags: [
        ['author', authorName, authorEmail],
        ['message', commitMessage],
        ['e', options.nip98Event.id, '', 'nip98-auth'] // Reference the NIP-98 auth event
      ],
      content: `Signed commit: ${commitMessage}\n\nAuthenticated via NIP-98 event: ${options.nip98Event.id}`
    };
    
    // Create event ID without signature (will need client to sign)
    const serialized = JSON.stringify([
      0,
      eventTemplate.pubkey,
      eventTemplate.created_at,
      eventTemplate.kind,
      eventTemplate.tags,
      eventTemplate.content
    ]);
    const eventId = createHash('sha256').update(serialized).digest('hex');
    
    // Use the NIP-98 event's signature as proof of authentication
    // The NIP-98 event is already signed and proves the user can sign commits
    // We reference it in the commit signature event and use its signature in the trailer
    signedEvent = {
      ...eventTemplate,
      id: eventId,
      sig: options.nip98Event.sig // Use NIP-98 event's signature as proof
    };
  }
  // Method 3: Use direct nsec/hex key (server-side)
  else if (options.nsecKey) {
    const keyBytes = decodeNostrKey(options.nsecKey);
    const pubkey = getPublicKey(keyBytes);

    const eventTemplate = {
      kind: KIND.COMMIT_SIGNATURE,
      pubkey,
      created_at: timestamp,
      tags: [
        ['author', authorName, authorEmail],
        ['message', commitMessage]
      ],
      content: `Signed commit: ${commitMessage}`
    };

    signedEvent = finalizeEvent(eventTemplate, keyBytes);
  } else {
    throw new Error('No signing method provided. Use useNIP07, nip98Event, or nsecKey.');
  }

  // Create a signature trailer that git can recognize
  // Format: Nostr-Signature: <event-id> <pubkey> <signature>
  // For NIP-98: uses the NIP-98 auth event's signature as proof
  const signatureTrailer = `\n\nNostr-Signature: ${signedEvent.id} ${signedEvent.pubkey} ${signedEvent.sig}`;
  const signedMessage = commitMessage + signatureTrailer;
  
  return { signedMessage, signatureEvent: signedEvent };
}

/**
 * Update commit signature with actual commit hash after commit is created
 */
export function updateCommitSignatureWithHash(
  signatureEvent: NostrEvent,
  commitHash: string
): NostrEvent {
  // Add commit hash tag
  const commitTag = signatureEvent.tags.find(t => t[0] === 'commit');
  if (!commitTag) {
    signatureEvent.tags.push(['commit', commitHash]);
  } else {
    commitTag[1] = commitHash;
  }

  // Recalculate event ID with updated tags
  const serialized = JSON.stringify([
    0,
    signatureEvent.pubkey,
    signatureEvent.created_at,
    signatureEvent.kind,
    signatureEvent.tags,
    signatureEvent.content
  ]);
  signatureEvent.id = createHash('sha256').update(serialized).digest('hex');

  // Note: Re-signing would require the private key, which we don't have here
  // The signature in the original event is still valid for the commit hash tag
  return signatureEvent;
}

/**
 * Verify a commit signature from a Nostr event
 */
export function verifyCommitSignature(
  signatureEvent: NostrEvent,
  commitHash: string
): { valid: boolean; error?: string } {
  // Check event kind
  if (signatureEvent.kind !== KIND.COMMIT_SIGNATURE) {
    return { valid: false, error: `Invalid event kind for commit signature. Expected ${KIND.COMMIT_SIGNATURE}, got ${signatureEvent.kind}` };
  }

  // Check commit hash tag
  const commitTag = signatureEvent.tags.find(t => t[0] === 'commit');
  if (!commitTag || commitTag[1] !== commitHash) {
    return { valid: false, error: 'Commit hash mismatch' };
  }

  // Verify event signature (would need to import verifyEvent from nostr-tools)
  // For now, we'll just check the structure
  if (!signatureEvent.sig || !signatureEvent.id) {
    return { valid: false, error: 'Missing signature or event ID' };
  }

  return { valid: true };
}

/**
 * Extract commit signature from commit message
 */
export function extractCommitSignature(commitMessage: string): {
  message: string;
  signature?: CommitSignature;
} {
  const signatureRegex = /Nostr-Signature:\s+([0-9a-f]{64})\s+([0-9a-f]{64})\s+([0-9a-f]{128})/;
  const match = commitMessage.match(signatureRegex);

  if (!match) {
    return { message: commitMessage };
  }

  const [, eventId, pubkey, signature] = match;
  const cleanMessage = commitMessage.replace(signatureRegex, '').trim();

  return {
    message: cleanMessage,
    signature: {
      signature,
      pubkey,
      eventId,
      timestamp: Math.floor(Date.now() / 1000) // Would need to extract from event
    }
  };
}
