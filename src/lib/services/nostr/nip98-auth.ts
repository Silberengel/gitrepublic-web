/**
 * NIP-98 HTTP Authentication service
 * Implements NIP-98 for authenticating HTTP requests using Nostr events
 */

import { verifyEvent } from 'nostr-tools';
import type { NostrEvent } from '../../types/nostr.js';
import { KIND } from '../../types/nostr.js';
import { createHash } from 'crypto';

export interface NIP98AuthResult {
  valid: boolean;
  error?: string;
  event?: NostrEvent;
  pubkey?: string;
}

/**
 * Verify NIP-98 authentication from Authorization header
 * 
 * @param authHeader - The Authorization header value (should start with "Nostr ")
 * @param requestUrl - The absolute request URL (including query parameters)
 * @param requestMethod - The HTTP method (GET, POST, etc.)
 * @param requestBody - Optional request body for payload verification
 * @returns Authentication result with validation status
 */
export function verifyNIP98Auth(
  authHeader: string | null,
  requestUrl: string,
  requestMethod: string,
  requestBody?: ArrayBuffer | Buffer | string
): NIP98AuthResult {
  // Check Authorization header format
  if (!authHeader || !authHeader.startsWith('Nostr ')) {
    return {
      valid: false,
      error: 'Missing or invalid Authorization header. Expected format: "Nostr <base64-encoded-event>"'
    };
  }

  try {
    // Decode base64 event
    // "Nostr " is 6 characters (N-o-s-t-r-space), so we slice from index 6
    const base64Event = authHeader.slice(6).trim(); // Remove "Nostr " prefix and trim whitespace
    const eventJson = Buffer.from(base64Event, 'base64').toString('utf-8');
    const nostrEvent: NostrEvent = JSON.parse(eventJson);

    // Validate kind (must be 27235)
    if (nostrEvent.kind !== KIND.NIP98_AUTH) {
      return {
        valid: false,
        error: `Invalid event kind. Expected ${KIND.NIP98_AUTH}, got ${nostrEvent.kind}`
      };
    }

    // Validate content is empty (SHOULD be empty per spec)
    if (nostrEvent.content && nostrEvent.content.trim() !== '') {
      return {
        valid: false,
        error: 'Event content should be empty for NIP-98 authentication'
      };
    }

    // Verify event signature
    if (!verifyEvent(nostrEvent)) {
      return {
        valid: false,
        error: 'Invalid event signature'
      };
    }

    // Check created_at timestamp (within 60 seconds per spec)
    const now = Math.floor(Date.now() / 1000);
    const eventAge = now - nostrEvent.created_at;
    if (eventAge > 60) {
      return {
        valid: false,
        error: 'Authentication event is too old (must be within 60 seconds)'
      };
    }
    if (eventAge < 0) {
      return {
        valid: false,
        error: 'Authentication event has future timestamp'
      };
    }

    // Validate 'u' tag (must match exact request URL)
    const uTag = nostrEvent.tags.find(t => t[0] === 'u');
    if (!uTag || !uTag[1]) {
      return {
        valid: false,
        error: "Missing 'u' tag in authentication event"
      };
    }

    // Normalize URLs for comparison (remove trailing slashes, handle encoding)
    const normalizeUrl = (url: string): string => {
      try {
        const parsed = new URL(url);
        // Remove trailing slash from pathname
        parsed.pathname = parsed.pathname.replace(/\/$/, '');
        return parsed.toString();
      } catch {
        return url;
      }
    };

    const eventUrl = normalizeUrl(uTag[1]);
    const requestUrlNormalized = normalizeUrl(requestUrl);

    if (eventUrl !== requestUrlNormalized) {
      return {
        valid: false,
        error: `URL mismatch. Event URL: ${eventUrl}, Request URL: ${requestUrlNormalized}`
      };
    }

    // Validate 'method' tag
    const methodTag = nostrEvent.tags.find(t => t[0] === 'method');
    if (!methodTag || !methodTag[1]) {
      return {
        valid: false,
        error: "Missing 'method' tag in authentication event"
      };
    }

    if (methodTag[1].toUpperCase() !== requestMethod.toUpperCase()) {
      return {
        valid: false,
        error: `HTTP method mismatch. Event method: ${methodTag[1]}, Request method: ${requestMethod}`
      };
    }

    // Validate 'payload' tag if present (for POST/PUT/PATCH with body)
    if (requestBody && ['POST', 'PUT', 'PATCH'].includes(requestMethod.toUpperCase())) {
      const payloadTag = nostrEvent.tags.find(t => t[0] === 'payload');
      if (payloadTag && payloadTag[1]) {
        // Calculate SHA256 of request body
        const bodyBuffer = typeof requestBody === 'string' 
          ? Buffer.from(requestBody, 'utf-8')
          : requestBody instanceof ArrayBuffer
          ? Buffer.from(requestBody)
          : requestBody;
        
        const bodyHash = createHash('sha256').update(bodyBuffer).digest('hex');
        
        if (payloadTag[1].toLowerCase() !== bodyHash.toLowerCase()) {
          return {
            valid: false,
            error: `Payload hash mismatch. Expected: ${payloadTag[1]}, Calculated: ${bodyHash}`
          };
        }
      }
    }

    return {
      valid: true,
      event: nostrEvent,
      pubkey: nostrEvent.pubkey
    };
  } catch (err) {
    return {
      valid: false,
      error: `Failed to parse or verify authentication: ${err instanceof Error ? err.message : String(err)}`
    };
  }
}

/**
 * Create a NIP-98 authentication event
 * This is a helper for clients to create properly formatted auth events
 */
export function createNIP98AuthEvent(
  pubkey: string,
  url: string,
  method: string,
  bodyHash?: string
): Omit<NostrEvent, 'sig' | 'id'> {
  const tags: string[][] = [
    ['u', url],
    ['method', method.toUpperCase()]
  ];

  if (bodyHash) {
    tags.push(['payload', bodyHash]);
  }

  return {
    kind: KIND.NIP98_AUTH,
    pubkey,
    created_at: Math.floor(Date.now() / 1000),
    content: '',
    tags
  };
}

/**
 * Calculate SHA256 hash of request body for payload tag
 */
export function calculateBodyHash(body: ArrayBuffer | Buffer | string): string {
  const bodyBuffer = typeof body === 'string' 
    ? Buffer.from(body, 'utf-8')
    : body instanceof ArrayBuffer
    ? Buffer.from(body)
    : body;
  
  return createHash('sha256').update(bodyBuffer).digest('hex');
}
