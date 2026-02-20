/**
 * Shared Nostr utility functions
 * Used across web-app, CLI, and API to ensure consistency
 */

import type { NostrEvent } from '../types/nostr.js';

/**
 * Extract clone URLs from a NIP-34 repo announcement event
 * 
 * This is a shared utility to avoid code duplication across:
 * - RepoManager (with URL normalization)
 * - Git API endpoint (for performance, without normalization)
 * - RepoPollingService
 * 
 * @param event - The Nostr repository announcement event
 * @param normalize - Whether to normalize URLs (add .git suffix if needed). Default: false
 * @returns Array of clone URLs
 */
export function extractCloneUrls(event: NostrEvent, normalize: boolean = false): string[] {
  const urls: string[] = [];
  
  for (const tag of event.tags) {
    if (tag[0] === 'clone') {
      for (let i = 1; i < tag.length; i++) {
        const url = tag[i];
        if (url && typeof url === 'string') {
          if (normalize) {
            urls.push(normalizeCloneUrl(url));
          } else {
            urls.push(url);
          }
        }
      }
    }
  }
  
  return urls;
}

/**
 * Normalize a clone URL to ensure it's cloneable
 * Adds .git suffix to HTTPS/HTTP URLs that don't have it
 * Handles Gitea URLs that might be missing .git extension
 */
export function normalizeCloneUrl(url: string): string {
  // Remove trailing slash
  url = url.trim().replace(/\/$/, '');
  
  // For HTTPS/HTTP URLs that don't end in .git, check if they're Gitea/GitHub/GitLab style
  // Pattern: https://domain.com/owner/repo (without .git)
  if ((url.startsWith('https://') || url.startsWith('http://')) && !url.endsWith('.git')) {
    // Check if it looks like a git hosting service URL (has at least 2 path segments)
    try {
      const urlObj = new URL(url);
      const pathParts = urlObj.pathname.split('/').filter(p => p);
      
      // If it has 2+ path segments (e.g., /owner/repo), add .git
      if (pathParts.length >= 2) {
        // Check if it's not already a file or has an extension
        const lastPart = pathParts[pathParts.length - 1];
        if (!lastPart.includes('.')) {
          return `${url}.git`;
        }
      }
    } catch {
      // URL parsing failed, return original
    }
  }
  
  return url;
}
