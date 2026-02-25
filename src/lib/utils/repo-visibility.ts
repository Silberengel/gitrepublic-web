/**
 * Repository visibility and relay publishing utilities
 * 
 * Visibility levels:
 * - public: Repo is public, events published to all relays + project-relay
 * - unlisted: Repo is public, events published to project-relay only
 * - restricted: Repo is private, events published to project-relay only
 * - private: Repo is private, events not published to relays (git-only, stored in repo)
 */

import type { NostrEvent } from '../types/nostr.js';
import { DEFAULT_NOSTR_RELAYS } from '../config.js';

export type VisibilityLevel = 'public' | 'unlisted' | 'restricted' | 'private';

/**
 * Get visibility level from repository announcement
 * Defaults to 'public' if not specified
 */
export function getVisibility(announcement: NostrEvent): VisibilityLevel {
  const visibilityTag = announcement.tags.find(t => t[0] === 'visibility' && t[1]);
  if (visibilityTag && visibilityTag[1]) {
    const level = visibilityTag[1].toLowerCase();
    if (['public', 'unlisted', 'restricted', 'private'].includes(level)) {
      return level as VisibilityLevel;
    }
  }
  
  // Default to public if not specified
  return 'public';
}

/**
 * Get project-relay URLs from repository announcement
 */
export function getProjectRelays(announcement: NostrEvent): string[] {
  return announcement.tags
    .filter(t => t[0] === 'project-relay')
    .flatMap(t => t.slice(1))
    .filter(url => url && typeof url === 'string') as string[];
}

/**
 * Determine which relays to publish events to based on visibility
 * 
 * @param announcement - Repository announcement event
 * @returns Array of relay URLs to publish to (empty array means no relay publishing)
 */
export function getRelaysForEventPublishing(announcement: NostrEvent): string[] {
  const visibility = getVisibility(announcement);
  const projectRelays = getProjectRelays(announcement);
  
  switch (visibility) {
    case 'public':
      // Publish to all default relays + project relays
      return [...new Set([...DEFAULT_NOSTR_RELAYS, ...projectRelays])];
    
    case 'unlisted':
    case 'restricted':
      // Publish to project relays only
      return projectRelays;
    
    case 'private':
      // No relay publishing - git-only
      return [];
    
    default:
      // Fallback to public behavior
      return [...new Set([...DEFAULT_NOSTR_RELAYS, ...projectRelays])];
  }
}

/**
 * Check if repository is private (restricted or private visibility)
 */
export function isPrivateRepo(announcement: NostrEvent): boolean {
  const visibility = getVisibility(announcement);
  return visibility === 'restricted' || visibility === 'private';
}

/**
 * Check if repository is discoverable (public or unlisted)
 */
export function isDiscoverableRepo(announcement: NostrEvent): boolean {
  const visibility = getVisibility(announcement);
  return visibility === 'public' || visibility === 'unlisted';
}
