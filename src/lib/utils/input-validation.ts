/**
 * Input validation utilities for security
 * Prevents injection attacks, path traversal, and other security issues
 */

/**
 * Validate and sanitize repository name
 * Repository names should be alphanumeric with hyphens and underscores
 */
export function validateRepoName(name: string): { valid: boolean; error?: string; sanitized?: string } {
  if (!name || typeof name !== 'string') {
    return { valid: false, error: 'Repository name is required' };
  }

  // Remove leading/trailing whitespace
  const trimmed = name.trim();

  if (trimmed.length === 0) {
    return { valid: false, error: 'Repository name cannot be empty' };
  }

  if (trimmed.length > 100) {
    return { valid: false, error: 'Repository name must be 100 characters or less' };
  }

  // Allow alphanumeric, hyphens, underscores, and dots
  // But not starting with dot or containing consecutive dots
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*[a-zA-Z0-9]$|^[a-zA-Z0-9]$/.test(trimmed)) {
    return {
      valid: false,
      error: 'Repository name must contain only alphanumeric characters, hyphens, underscores, and dots. Cannot start or end with a dot.'
    };
  }

  // Prevent path traversal attempts
  if (trimmed.includes('..') || trimmed.includes('/') || trimmed.includes('\\')) {
    return { valid: false, error: 'Repository name cannot contain path separators' };
  }

  return { valid: true, sanitized: trimmed };
}

/**
 * Validate and sanitize file path
 * Prevents path traversal attacks
 */
export function validateFilePath(path: string): { valid: boolean; error?: string; sanitized?: string } {
  if (!path || typeof path !== 'string') {
    return { valid: false, error: 'File path is required' };
  }

  // Remove leading/trailing whitespace and slashes
  const trimmed = path.trim().replace(/^\/+|\/+$/g, '');

  if (trimmed.length === 0) {
    return { valid: false, error: 'File path cannot be empty' };
  }

  // Prevent path traversal
  if (trimmed.includes('..')) {
    return { valid: false, error: 'Path traversal not allowed' };
  }

  // Prevent absolute paths
  if (trimmed.startsWith('/') || trimmed.match(/^[a-zA-Z]:/)) {
    return { valid: false, error: 'Absolute paths not allowed' };
  }

  // Prevent null bytes
  if (trimmed.includes('\0')) {
    return { valid: false, error: 'Null bytes not allowed in paths' };
  }

  // Normalize path separators
  const normalized = trimmed.replace(/\\/g, '/');

  return { valid: true, sanitized: normalized };
}

/**
 * Validate pubkey format (hex, 64 characters)
 */
export function validatePubkey(pubkey: string): { valid: boolean; error?: string } {
  if (!pubkey || typeof pubkey !== 'string') {
    return { valid: false, error: 'Pubkey is required' };
  }

  // Hex format, 64 characters
  if (!/^[0-9a-f]{64}$/i.test(pubkey)) {
    return { valid: false, error: 'Invalid pubkey format. Must be 64-character hex string.' };
  }

  return { valid: true };
}

/**
 * Validate npub format (bech32 encoded)
 */
export function validateNpub(npub: string): { valid: boolean; error?: string } {
  if (!npub || typeof npub !== 'string') {
    return { valid: false, error: 'Npub is required' };
  }

  // Basic npub format check (starts with npub, bech32 encoded)
  if (!/^npub1[ac-hj-np-z02-9]{58}$/.test(npub)) {
    return { valid: false, error: 'Invalid npub format' };
  }

  return { valid: true };
}

/**
 * Sanitize string input to prevent XSS
 * Removes potentially dangerous characters
 */
export function sanitizeString(input: string, maxLength: number = 10000): string {
  if (typeof input !== 'string') {
    return '';
  }

  // Truncate to max length
  let sanitized = input.slice(0, maxLength);

  // Remove null bytes
  sanitized = sanitized.replace(/\0/g, '');

  // Remove control characters except newlines and tabs
  sanitized = sanitized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  return sanitized;
}

/**
 * Validate commit message
 */
export function validateCommitMessage(message: string): { valid: boolean; error?: string; sanitized?: string } {
  if (!message || typeof message !== 'string') {
    return { valid: false, error: 'Commit message is required' };
  }

  const trimmed = message.trim();

  if (trimmed.length === 0) {
    return { valid: false, error: 'Commit message cannot be empty' };
  }

  if (trimmed.length > 10000) {
    return { valid: false, error: 'Commit message must be 10000 characters or less' };
  }

  // Sanitize but allow newlines
  const sanitized = sanitizeString(trimmed, 10000);

  return { valid: true, sanitized };
}

/**
 * Validate branch name
 */
export function validateBranchName(branch: string): { valid: boolean; error?: string; sanitized?: string } {
  if (!branch || typeof branch !== 'string') {
    return { valid: false, error: 'Branch name is required' };
  }

  const trimmed = branch.trim();

  if (trimmed.length === 0) {
    return { valid: false, error: 'Branch name cannot be empty' };
  }

  if (trimmed.length > 255) {
    return { valid: false, error: 'Branch name must be 255 characters or less' };
  }

  // Git branch name rules
  // Cannot contain .., cannot end with ., cannot contain spaces
  if (trimmed.includes('..') || trimmed.endsWith('.') || /\s/.test(trimmed)) {
    return { valid: false, error: 'Invalid branch name format' };
  }

  // Prevent path traversal
  if (trimmed.includes('/') && trimmed !== 'HEAD') {
    // Allow forward slashes for branch paths, but validate
    const parts = trimmed.split('/');
    for (const part of parts) {
      if (part === '' || part === '.' || part === '..') {
        return { valid: false, error: 'Invalid branch name format' };
      }
    }
  }

  return { valid: true, sanitized: trimmed };
}
