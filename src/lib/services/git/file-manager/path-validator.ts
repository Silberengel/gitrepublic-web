/**
 * Path validation utilities
 * Security-focused path validation to prevent path traversal attacks
 */

import { normalize, resolve } from 'path';
import logger from '../../logger.js';

export interface ValidationResult {
  valid: boolean;
  error?: string;
  normalized?: string;
}

/**
 * Validate and sanitize file path to prevent path traversal attacks
 */
export function validateFilePath(filePath: string): ValidationResult {
  // Allow empty string for root directory
  if (filePath === '') {
    return { valid: true, normalized: '' };
  }
  
  if (!filePath || typeof filePath !== 'string') {
    return { valid: false, error: 'File path must be a non-empty string' };
  }

  // Normalize the path (resolves .. and .)
  const normalized = normalize(filePath);
  
  // Check for path traversal attempts
  if (normalized.includes('..')) {
    logger.security('Path traversal attempt detected', { filePath, normalized });
    return { valid: false, error: 'Path traversal detected (..)' };
  }

  // Check for absolute paths
  if (normalized.startsWith('/')) {
    return { valid: false, error: 'Absolute paths are not allowed' };
  }

  // Check for null bytes
  if (normalized.includes('\0')) {
    logger.security('Null byte detected in path', { filePath });
    return { valid: false, error: 'Null bytes are not allowed in paths' };
  }

  // Check for control characters
  if (/[\x00-\x1f\x7f]/.test(normalized)) {
    logger.security('Control character detected in path', { filePath });
    return { valid: false, error: 'Control characters are not allowed in paths' };
  }

  // Limit path length (reasonable limit)
  if (normalized.length > 4096) {
    return { valid: false, error: 'Path is too long (max 4096 characters)' };
  }

  return { valid: true, normalized };
}

/**
 * Validate repository name to prevent injection attacks
 */
export function validateRepoName(repoName: string): ValidationResult {
  if (!repoName || typeof repoName !== 'string') {
    return { valid: false, error: 'Repository name must be a non-empty string' };
  }

  // Check length
  if (repoName.length > 100) {
    return { valid: false, error: 'Repository name is too long (max 100 characters)' };
  }

  // Check for invalid characters (alphanumeric, hyphens, underscores, dots)
  if (!/^[a-zA-Z0-9._-]+$/.test(repoName)) {
    logger.security('Invalid characters in repo name', { repoName });
    return { valid: false, error: 'Repository name contains invalid characters' };
  }

  // Check for path traversal
  if (repoName.includes('..') || repoName.includes('/') || repoName.includes('\\')) {
    logger.security('Path traversal attempt in repo name', { repoName });
    return { valid: false, error: 'Repository name contains invalid path characters' };
  }

  return { valid: true, normalized: repoName };
}

/**
 * Validate npub format
 */
export function validateNpub(npub: string): ValidationResult {
  if (!npub || typeof npub !== 'string') {
    return { valid: false, error: 'npub must be a non-empty string' };
  }

  // Basic npub format check (starts with npub, base58 encoded)
  if (!npub.startsWith('npub1') || npub.length < 10 || npub.length > 100) {
    return { valid: false, error: 'Invalid npub format' };
  }

  return { valid: true, normalized: npub };
}

/**
 * Validate repository path is within allowed root
 */
export function validateRepoPath(
  repoPath: string,
  repoRoot: string
): ValidationResult {
  try {
    const resolvedPath = resolve(repoPath).replace(/\\/g, '/');
    const resolvedRoot = resolve(repoRoot).replace(/\\/g, '/');
    
    // Must be a subdirectory of repoRoot, not equal to it
    if (!resolvedPath.startsWith(resolvedRoot + '/')) {
      logger.security('Repository path outside allowed root', { repoPath, repoRoot });
      return { valid: false, error: 'Path traversal detected: repository path outside allowed root' };
    }
    
    return { valid: true, normalized: resolvedPath };
  } catch (error) {
    logger.error({ error, repoPath, repoRoot }, 'Failed to validate repo path');
    return { valid: false, error: 'Failed to validate repository path' };
  }
}
