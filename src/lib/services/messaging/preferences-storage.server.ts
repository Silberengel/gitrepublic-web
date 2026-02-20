/**
 * Secure messaging preferences storage
 * 
 * SECURITY FEATURES:
 * - Encrypted salt storage (separate key)
 * - HMAC-based lookup keys (pubkey never directly used as DB key)
 * - Rate limiting on decryption attempts
 * - Per-user key derivation (master key + pubkey + salt)
 * - AES-256-GCM authenticated encryption
 * - Random IV per encryption
 * 
 * NOTE: This module uses Node.js crypto and should only be used server-side.
 * It will throw an error if imported in browser/client code.
 */

// This file uses .server.ts suffix so SvelteKit automatically excludes it from client bundles
// The runtime check below is a safety measure
if (typeof window !== 'undefined') {
  throw new Error('preferences-storage.server.ts uses Node.js crypto and cannot be imported in browser code. Use API endpoints instead.');
}

import { 
  createCipheriv, 
  createDecipheriv, 
  randomBytes, 
  scryptSync,
  createHash,
  createHmac
} from 'crypto';
import logger from '../logger.js';
import { getCachedUserLevel } from '../security/user-level-cache.js';
import type { MessagingPreferences } from './preferences-types.js';

// Re-export the type for convenience
export type { MessagingPreferences } from './preferences-types.js';

// Encryption keys from environment (NEVER commit these!)
// These are optional - if not set, messaging preferences will be disabled
const ENCRYPTION_KEY = process.env.MESSAGING_PREFS_ENCRYPTION_KEY;
const SALT_ENCRYPTION_KEY = process.env.MESSAGING_SALT_ENCRYPTION_KEY;
const LOOKUP_SECRET = process.env.MESSAGING_LOOKUP_SECRET;

// Check if messaging preferences are configured
const isMessagingConfigured = !!(ENCRYPTION_KEY && SALT_ENCRYPTION_KEY && LOOKUP_SECRET);

if (!isMessagingConfigured) {
  logger.info('Messaging preferences storage is disabled (optional feature). To enable, set environment variables: MESSAGING_PREFS_ENCRYPTION_KEY, MESSAGING_SALT_ENCRYPTION_KEY, MESSAGING_LOOKUP_SECRET');
}

interface StoredPreferences {
  encryptedSalt: string;  // Salt encrypted with SALT_ENCRYPTION_KEY
  encrypted: string;      // Preferences encrypted with derived key
}

// Rate limiting: track decryption attempts per pubkey
interface DecryptionAttempt {
  count: number;
  resetAt: number;
}

const decryptionAttempts = new Map<string, DecryptionAttempt>();
const MAX_DECRYPTION_ATTEMPTS = 10; // Max attempts per window
const DECRYPTION_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

// Cleanup expired rate limit entries
setInterval(() => {
  const now = Date.now();
  for (const [key, attempt] of decryptionAttempts.entries()) {
    if (attempt.resetAt < now) {
      decryptionAttempts.delete(key);
    }
  }
}, 60 * 1000); // Cleanup every minute

/**
 * Generate HMAC-based lookup key from pubkey
 * Prevents pubkey from being directly used as database key
 */
function getLookupKey(userPubkeyHex: string): string {
  if (!LOOKUP_SECRET) {
    throw new Error('Messaging preferences are not configured. LOOKUP_SECRET environment variable is missing.');
  }
  return createHmac('sha256', LOOKUP_SECRET)
    .update(userPubkeyHex)
    .digest('hex');
}

function checkRateLimit(userPubkeyHex: string): { allowed: boolean; remaining: number } {
  // If not configured, allow all (no rate limiting)
  if (!isMessagingConfigured) {
    return { allowed: true, remaining: MAX_DECRYPTION_ATTEMPTS };
  }

  const lookupKey = getLookupKey(userPubkeyHex);
  const now = Date.now();
  
  const attempt = decryptionAttempts.get(lookupKey);
  
  if (!attempt || attempt.resetAt < now) {
    // New window or expired
    decryptionAttempts.set(lookupKey, {
      count: 1,
      resetAt: now + DECRYPTION_WINDOW_MS
    });
    return { allowed: true, remaining: MAX_DECRYPTION_ATTEMPTS - 1 };
  }
  
  if (attempt.count >= MAX_DECRYPTION_ATTEMPTS) {
    logger.warn({ userPubkeyHex: userPubkeyHex.slice(0, 16) + '...' }, 
      'Decryption rate limit exceeded');
    return { allowed: false, remaining: 0 };
  }
  
  attempt.count++;
  return { allowed: true, remaining: MAX_DECRYPTION_ATTEMPTS - attempt.count };
}


/**
 * Encrypt data with AES-256-GCM
 */
function encryptAES256GCM(key: Buffer, plaintext: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  
  return JSON.stringify({
    iv: iv.toString('hex'),
    tag: authTag.toString('hex'),
    data: encrypted
  });
}

/**
 * Decrypt data with AES-256-GCM
 */
function decryptAES256GCM(key: Buffer, encryptedData: string): string {
  const { iv, tag, data } = JSON.parse(encryptedData);
  
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  
  let decrypted = decipher.update(data, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}

/**
 * Encrypt salt with SALT_ENCRYPTION_KEY
 */
function encryptSalt(salt: string): string {
  if (!SALT_ENCRYPTION_KEY) {
    throw new Error('SALT_ENCRYPTION_KEY not configured');
  }
  const key = createHash('sha256').update(SALT_ENCRYPTION_KEY).digest();
  return encryptAES256GCM(key, salt);
}

/**
 * Decrypt salt with SALT_ENCRYPTION_KEY
 */
function decryptSalt(encryptedSalt: string): string {
  if (!SALT_ENCRYPTION_KEY) {
    throw new Error('SALT_ENCRYPTION_KEY not configured');
  }
  const key = createHash('sha256').update(SALT_ENCRYPTION_KEY).digest();
  return decryptAES256GCM(key, encryptedSalt);
}

/**
 * Derive per-user encryption key
 * Uses: master key + user pubkey + salt
 */
function deriveUserKey(userPubkeyHex: string, salt: string): Buffer {
  if (!ENCRYPTION_KEY) {
    throw new Error('ENCRYPTION_KEY not configured');
  }
  // Combine pubkey and salt for key derivation
  // Attacker needs: master key + pubkey + salt
  const combinedSalt = `${userPubkeyHex}:${salt}`;
  return scryptSync(
    ENCRYPTION_KEY,
    combinedSalt,
    32, // 256-bit key
    { N: 16384, r: 8, p: 1 } // scrypt parameters
  );
}

/**
 * DEPRECATED: Preferences are now stored client-side in IndexedDB via settings-store.ts
 * This server-side storage is kept for backward compatibility but should not be used.
 * Use preferences-storage.client.ts for new code.
 * 
 * The in-memory Map has been removed - preferences are stored in IndexedDB on the client.
 */

/**
 * Store user messaging preferences securely
 * 
 * @param userPubkeyHex - User's public key (hex)
 * @param preferences - Messaging preferences to store
 * @throws Error if user doesn't have unlimited access
 */
export async function storePreferences(
  userPubkeyHex: string,
  preferences: MessagingPreferences
): Promise<void> {
  if (!isMessagingConfigured) {
    throw new Error('Messaging preferences are not configured. Please set MESSAGING_PREFS_ENCRYPTION_KEY, MESSAGING_SALT_ENCRYPTION_KEY, and MESSAGING_LOOKUP_SECRET environment variables.');
  }

  // Verify user has unlimited access
  const cached = getCachedUserLevel(userPubkeyHex);
  const { hasUnlimitedAccess } = await import('../../utils/user-access.js');
  if (!hasUnlimitedAccess(cached?.level)) {
    throw new Error('Messaging forwarding requires unlimited access');
  }

  // Generate random salt (unique per user, per save)
  const salt = randomBytes(32).toString('hex');
  
  // Encrypt salt with separate key
  const encryptedSalt = encryptSalt(salt);
  
  // Derive user-specific encryption key
  const userKey = deriveUserKey(userPubkeyHex, salt);
  
  // Encrypt preferences
  const encrypted = encryptAES256GCM(userKey, JSON.stringify(preferences));
  
  // DEPRECATED: Preferences should be stored client-side in IndexedDB
  // This function is kept for backward compatibility but does nothing
  // Use preferences-storage.client.ts instead
  
  logger.warn({ userPubkeyHex: userPubkeyHex.slice(0, 16) + '...' }, 
    'storePreferences called on deprecated server-side storage. Preferences should be stored client-side in IndexedDB.');
}

/**
 * Retrieve and decrypt user messaging preferences
 * 
 * @param userPubkeyHex - User's public key (hex)
 * @returns Decrypted preferences or null if not found
 * @throws Error if rate limit exceeded or decryption fails
 */
export async function getPreferences(
  userPubkeyHex: string
): Promise<MessagingPreferences | null> {
  if (!isMessagingConfigured) {
    // If not configured, return null (no preferences stored)
    return null;
  }

  // Check rate limit
  const rateLimit = checkRateLimit(userPubkeyHex);
  if (!rateLimit.allowed) {
    throw new Error(
      `Decryption rate limit exceeded. Try again in ${Math.ceil(
        (decryptionAttempts.get(getLookupKey(userPubkeyHex))!.resetAt - Date.now()) / 1000 / 60
      )} minutes.`
    );
  }

  // DEPRECATED: Preferences are now stored client-side in IndexedDB
  // This function always returns null - use preferences-storage.client.ts instead
  
  logger.warn({ userPubkeyHex: userPubkeyHex.slice(0, 16) + '...' }, 
    'getPreferences called on deprecated server-side storage. Use preferences-storage.client.ts to read from IndexedDB.');
  
  return null;

  // DEPRECATED: This code path is no longer used
  // Preferences are stored client-side in IndexedDB
  return null;
}

/**
 * Delete user messaging preferences
 */
export async function deletePreferences(userPubkeyHex: string): Promise<void> {
  // DEPRECATED: Preferences are now stored client-side in IndexedDB
  // This function does nothing - use preferences-storage.client.ts instead
  
  logger.warn({ userPubkeyHex: userPubkeyHex.slice(0, 16) + '...' }, 
    'deletePreferences called on deprecated server-side storage. Use preferences-storage.client.ts to delete from IndexedDB.');
}

/**
 * Check if user has preferences configured
 */
export async function hasPreferences(userPubkeyHex: string): Promise<boolean> {
  // DEPRECATED: Preferences are now stored client-side in IndexedDB
  // This function always returns false - use preferences-storage.client.ts instead
  
  return false;
}

/**
 * Get rate limit status for a user
 */
export function getRateLimitStatus(userPubkeyHex: string): {
  remaining: number;
  resetAt: number | null;
} {
  const lookupKey = getLookupKey(userPubkeyHex);
  const attempt = decryptionAttempts.get(lookupKey);
  
  if (!attempt) {
    return { remaining: MAX_DECRYPTION_ATTEMPTS, resetAt: null };
  }
  
  if (attempt.resetAt < Date.now()) {
    return { remaining: MAX_DECRYPTION_ATTEMPTS, resetAt: null };
  }
  
  return {
    remaining: Math.max(0, MAX_DECRYPTION_ATTEMPTS - attempt.count),
    resetAt: attempt.resetAt
  };
}

/**
 * Get a safe summary of user preferences (without sensitive tokens)
 * This decrypts preferences but only returns safe information
 */
export async function getPreferencesSummary(userPubkeyHex: string): Promise<{
  configured: boolean;
  enabled: boolean;
  platforms: {
    telegram?: boolean;
    simplex?: boolean;
    email?: boolean;
    gitPlatforms?: Array<{
      platform: string;
      owner: string;
      repo: string;
      apiUrl?: string;
    }>;
  };
  notifyOn?: string[];
} | null> {
  try {
    // If not configured, return null (not configured)
    if (!isMessagingConfigured) {
      return null;
    }

    const preferences = await getPreferences(userPubkeyHex);
    
    if (!preferences) {
      return null;
    }

    return {
      configured: true,
      enabled: preferences.enabled,
      platforms: {
        telegram: !!preferences.telegram,
        simplex: !!preferences.simplex,
        email: !!preferences.email,
        gitPlatforms: preferences.gitPlatforms?.map(gp => ({
          platform: gp.platform,
          owner: gp.owner,
          repo: gp.repo,
          apiUrl: gp.apiUrl
          // token is intentionally omitted
        }))
      },
      notifyOn: preferences.notifyOn
    };
  } catch (err) {
    // If any error occurs (e.g., decryption fails, not configured, etc.), return null
    logger.warn({ error: err, userPubkeyHex: userPubkeyHex.slice(0, 16) + '...' }, 
      'Failed to get preferences summary');
    return null;
  }
}
