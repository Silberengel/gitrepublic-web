#!/usr/bin/env node
/**
 * Git credential helper for GitRepublic using NIP-98 authentication
 * 
 * This script implements the git credential helper protocol to automatically
 * generate NIP-98 authentication tokens for git operations.
 * 
 * Usage:
 *   1. Make it executable: chmod +x scripts/git-credential-nostr.js
 *   2. Configure git:
 *      git config --global credential.helper '!node /path/to/gitrepublic-web/scripts/git-credential-nostr.js'
 *   3. Or for a specific domain:
 *      git config --global credential.https://your-domain.com.helper '!node /path/to/gitrepublic-web/scripts/git-credential-nostr.js'
 * 
 * Environment variables:
 *   NOSTRGIT_SECRET_KEY_CLIENT - Your Nostr private key (nsec format or hex) for client-side git operations
 * 
 * Security: Keep your NOSTRGIT_SECRET_KEY_CLIENT secure and never commit it to version control!
 */

import { createHash } from 'crypto';
import { getEventHash, signEvent, getPublicKey } from 'nostr-tools';
import { decode } from 'nostr-tools/nip19';

// NIP-98 auth event kind
const KIND_NIP98_AUTH = 27235;

/**
 * Read input from stdin (git credential helper protocol)
 */
function readInput() {
  const chunks = [];
  process.stdin.setEncoding('utf8');
  
  return new Promise((resolve) => {
    process.stdin.on('readable', () => {
      let chunk;
      while ((chunk = process.stdin.read()) !== null) {
        chunks.push(chunk);
      }
    });
    
    process.stdin.on('end', () => {
      const input = chunks.join('');
      const lines = input.trim().split('\n');
      const data = {};
      
      for (const line of lines) {
        if (!line) continue;
        const [key, ...valueParts] = line.split('=');
        if (key && valueParts.length > 0) {
          data[key] = valueParts.join('=');
        }
      }
      
      resolve(data);
    });
  });
}

/**
 * Normalize URL for NIP-98 (remove trailing slashes, ensure consistent format)
 */
function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    // Remove trailing slash from pathname
    parsed.pathname = parsed.pathname.replace(/\/$/, '');
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Calculate SHA256 hash of request body
 */
function calculateBodyHash(body) {
  if (!body) return null;
  const buffer = Buffer.from(body, 'utf-8');
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Create and sign a NIP-98 authentication event
 */
function createNIP98AuthEvent(privateKey, url, method, bodyHash = null) {
  const pubkey = getPublicKey(privateKey);
  const tags = [
    ['u', normalizeUrl(url)],
    ['method', method.toUpperCase()]
  ];
  
  if (bodyHash) {
    tags.push(['payload', bodyHash]);
  }
  
  const event = {
    kind: KIND_NIP98_AUTH,
    pubkey,
    created_at: Math.floor(Date.now() / 1000),
    content: '',
    tags
  };
  
  // Sign the event
  event.id = getEventHash(event);
  event.sig = signEvent(event, privateKey);
  
  return event;
}

/**
 * Main credential helper logic
 */
async function main() {
  try {
    // Read input from git
    const input = await readInput();
    
    // Get command (get, store, erase)
    const command = process.argv[2] || 'get';
    
    // For 'get' command, generate credentials
    if (command === 'get') {
      // Get private key from environment variable
      // Support NOSTRGIT_SECRET_KEY_CLIENT (preferred), with fallbacks for backward compatibility
      const nsec = process.env.NOSTRGIT_SECRET_KEY_CLIENT || process.env.NOSTR_PRIVATE_KEY || process.env.NSEC;
      if (!nsec) {
        console.error('Error: NOSTRGIT_SECRET_KEY_CLIENT environment variable is not set');
        console.error('Set it with: export NOSTRGIT_SECRET_KEY_CLIENT="nsec1..." or NOSTRGIT_SECRET_KEY_CLIENT="<hex-key>"');
        process.exit(1);
      }
      
      // Parse private key (handle both nsec and hex formats)
      let privateKey;
      if (nsec.startsWith('nsec')) {
        try {
          const decoded = decode(nsec);
          if (decoded.type === 'nsec') {
            privateKey = decoded.data;
          } else {
            throw new Error('Invalid nsec format - decoded type is not nsec');
          }
        } catch (err) {
          console.error('Error decoding nsec:', err.message);
          process.exit(1);
        }
      } else {
        // Assume hex format (32 bytes = 64 hex characters)
        if (nsec.length !== 64) {
          console.error('Error: Hex private key must be 64 characters (32 bytes)');
          process.exit(1);
        }
        privateKey = nsec;
      }
      
      // Extract URL components from input
      const protocol = input.protocol || 'https';
      const host = input.host;
      const path = input.path || '';
      
      if (!host) {
        console.error('Error: No host specified in credential request');
        process.exit(1);
      }
      
      // Build full URL
      const url = `${protocol}://${host}${path}`;
      
      // Determine HTTP method based on git operation
      // Git credential helper doesn't know the HTTP method, but we can infer it:
      // - If path contains 'git-receive-pack', it's a push (POST)
      // - Otherwise, it's likely a fetch/clone (GET)
      // Note: For initial info/refs requests, git uses GET, so we default to GET
      // For actual push operations, git will make POST requests to git-receive-pack
      // The server will validate the method matches, so we need to handle this carefully
      const method = path.includes('git-receive-pack') ? 'POST' : 'GET';
      
      // Create and sign NIP-98 auth event
      const authEvent = createNIP98AuthEvent(privateKey, url, method);
      
      // Encode event as base64
      const eventJson = JSON.stringify(authEvent);
      const base64Event = Buffer.from(eventJson, 'utf-8').toString('base64');
      
      // Output credentials in git credential helper format
      // Username can be anything (git doesn't use it for NIP-98)
      // Password is the base64-encoded signed event
      console.log('username=nostr');
      console.log(`password=${base64Event}`);
      
    } else if (command === 'store') {
      // For 'store', we don't need to do anything (credentials are generated on-demand)
      // Just exit successfully
      process.exit(0);
    } else if (command === 'erase') {
      // For 'erase', we don't need to do anything
      // Just exit successfully
      process.exit(0);
    } else {
      console.error(`Error: Unknown command: ${command}`);
      process.exit(1);
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

// Run main function
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
