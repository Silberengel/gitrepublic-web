/**
 * Security utilities for safe logging and data handling
 */

/**
 * Truncate a pubkey/npub for safe logging
 * Shows first 8 and last 4 characters: abc12345...xyz9
 */
export function truncatePubkey(pubkey: string | null | undefined): string {
  if (!pubkey) return 'unknown';
  if (pubkey.length <= 16) return pubkey; // Already short, return as-is
  
  // For hex pubkeys (64 chars) or npubs (longer), truncate
  if (pubkey.length > 16) {
    return `${pubkey.slice(0, 8)}...${pubkey.slice(-4)}`;
  }
  
  return pubkey;
}

/**
 * Truncate an npub for display
 * Shows first 12 characters: npub1abc123...
 */
export function truncateNpub(npub: string | null | undefined): string {
  if (!npub) return 'unknown';
  if (npub.length <= 16) return npub;
  return `${npub.slice(0, 12)}...`;
}

/**
 * Sanitize error messages to prevent leaking sensitive data
 */
export function sanitizeError(error: unknown): string {
  if (error instanceof Error) {
    let message = error.message;
    
    // Remove potential private key patterns
    message = message.replace(/nsec[0-9a-z]+/gi, '[REDACTED]');
    message = message.replace(/[0-9a-f]{64}/g, '[REDACTED]'); // 64-char hex keys
    
    // Remove password patterns
    message = message.replace(/password[=:]\s*\S+/gi, 'password=[REDACTED]');
    message = message.replace(/pwd[=:]\s*\S+/gi, 'pwd=[REDACTED]');
    
    // Truncate long pubkeys in error messages
    message = message.replace(/(npub[a-z0-9]{50,})/gi, (match) => truncateNpub(match));
    message = message.replace(/([0-9a-f]{50,})/g, (match) => truncatePubkey(match));
    
    return message;
  }
  return String(error);
}

/**
 * Validate branch name to prevent injection attacks
 */
export function isValidBranchName(name: string): boolean {
  if (!name || typeof name !== 'string') return false;
  if (name.length === 0 || name.length > 255) return false;
  if (name.startsWith('.') || name.startsWith('-')) return false;
  if (name.includes('..') || name.includes('//')) return false;
  // Allow alphanumeric, dots, hyphens, underscores, and forward slashes
  // But not at the start or end
  if (!/^[a-zA-Z0-9._/-]+$/.test(name)) return false;
  if (name.endsWith('.') || name.endsWith('-') || name.endsWith('/')) return false;
  // Git reserved names
  const reserved = ['HEAD', 'MERGE_HEAD', 'FETCH_HEAD', 'ORIG_HEAD'];
  if (reserved.includes(name.toUpperCase())) return false;
  return true;
}

/**
 * Check if a string might contain a private key
 */
export function mightContainPrivateKey(str: string): boolean {
  // Check for nsec pattern
  if (/^nsec[0-9a-z]+$/i.test(str)) return true;
  
  // Check for 64-char hex (potential private key)
  if (/^[0-9a-f]{64}$/i.test(str)) return true;
  
  return false;
}

/**
 * Redact sensitive data from objects before logging
 */
export function redactSensitiveData(obj: Record<string, any>): Record<string, any> {
  const redacted = { ...obj };
  const sensitiveKeys = ['nsec', 'nsecKey', 'secret', 'privateKey', 'key', 'password', 'token', 'auth'];
  
  for (const key of Object.keys(redacted)) {
    const lowerKey = key.toLowerCase();
    if (sensitiveKeys.some(sk => lowerKey.includes(sk))) {
      redacted[key] = '[REDACTED]';
    } else if (typeof redacted[key] === 'string' && mightContainPrivateKey(redacted[key])) {
      redacted[key] = '[REDACTED]';
    } else if (typeof redacted[key] === 'object' && redacted[key] !== null) {
      redacted[key] = redactSensitiveData(redacted[key]);
    }
  }
  
  return redacted;
}
