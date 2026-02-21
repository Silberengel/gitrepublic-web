/**
 * Shared Nostr utility functions
 * Used across web-app, CLI, and API to ensure consistency
 */

import type { NostrEvent, NostrFilter } from '../types/nostr.js';
import { KIND } from '../types/nostr.js';

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

/**
 * Fetch repository announcements by author with caching (case-insensitive)
 * This helper function provides consistent caching behavior across all endpoints
 * 
 * @param nostrClient - The Nostr client to use for fetching
 * @param authorPubkey - The author's pubkey (hex)
 * @param eventCache - The event cache instance (optional, will import if not provided)
 * @returns Promise resolving to all announcements by the author
 */
export async function fetchRepoAnnouncementsWithCache(
  nostrClient: { fetchEvents: (filters: NostrFilter[]) => Promise<NostrEvent[]> },
  authorPubkey: string,
  eventCache?: { get: (filters: NostrFilter[]) => NostrEvent[] | null; set: (filters: NostrFilter[], events: NostrEvent[]) => void } | null
): Promise<NostrEvent[]> {
  const filters: NostrFilter[] = [
    {
      kinds: [KIND.REPO_ANNOUNCEMENT],
      authors: [authorPubkey],
      limit: 100 // Fetch more to allow case-insensitive filtering
    }
  ];
  
  // Lazy import eventCache if not provided (for server-side usage)
  let cache = eventCache;
  if (!cache) {
    try {
      const cacheModule = await import('../services/nostr/event-cache.js');
      cache = cacheModule.eventCache;
    } catch {
      // Cache not available, skip caching
      cache = null;
    }
  }
  
  // Check cache first
  if (cache) {
    const cachedEvents = cache.get(filters);
    if (cachedEvents && cachedEvents.length > 0) {
      // Return cached events immediately, fetch fresh in background
      nostrClient.fetchEvents(filters).then(freshEvents => {
        // Merge fresh events with cached ones (deduplicate by event ID)
        const eventMap = new Map<string, NostrEvent>();
        cachedEvents.forEach(e => eventMap.set(e.id, e));
        freshEvents.forEach(e => {
          const existing = eventMap.get(e.id);
          if (!existing || e.created_at > existing.created_at) {
            eventMap.set(e.id, e);
          }
        });
        const mergedEvents = Array.from(eventMap.values());
        cache!.set(filters, mergedEvents);
      }).catch(() => {
        // Ignore background fetch errors
      });
      
      return cachedEvents;
    }
  }
  
  // No cache, fetch from relays
  const freshEvents = await nostrClient.fetchEvents(filters);
  // Cache the results
  if (cache && freshEvents.length > 0) {
    cache.set(filters, freshEvents);
  }
  return freshEvents;
}

/**
 * Find a repository announcement by repo name (case-insensitive)
 * 
 * @param events - Array of announcement events
 * @param repoName - The repository name to find
 * @returns The matching announcement event or null
 */
export function findRepoAnnouncement(events: NostrEvent[], repoName: string): NostrEvent | null {
  const repoLower = repoName.toLowerCase();
  const matching = events.filter(event => {
    const dTag = event.tags.find((t: string[]) => t[0] === 'd')?.[1];
    return dTag && dTag.toLowerCase() === repoLower;
  });
  return matching.length > 0 ? matching[0] : null;
}
