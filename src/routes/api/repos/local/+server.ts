/**
 * API endpoint for listing local repository clones
 * Returns local repos with their announcements, filtered by privacy
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readdir, stat } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { NostrClient } from '$lib/services/nostr/nostr-client.js';
import { MaintainerService } from '$lib/services/nostr/maintainer-service.js';
import { DEFAULT_NOSTR_RELAYS, GIT_DOMAIN } from '$lib/config.js';
import { KIND } from '$lib/types/nostr.js';
import { nip19 } from 'nostr-tools';
import { handleApiError } from '$lib/utils/error-handler.js';
import { extractRequestContext } from '$lib/utils/api-context.js';
import logger from '$lib/services/logger.js';
import type { NostrEvent } from '$lib/types/nostr.js';
import type { RequestEvent } from '@sveltejs/kit';
import { eventCache } from '$lib/services/nostr/event-cache.js';
import { fetchRepoAnnouncementsWithCache, findRepoAnnouncement } from '$lib/utils/nostr-utils.js';

const nostrClient = new NostrClient(DEFAULT_NOSTR_RELAYS);
const maintainerService = new MaintainerService(DEFAULT_NOSTR_RELAYS);

// Cache for local repo list (5 minute TTL)
interface CacheEntry {
  repos: LocalRepoItem[];
  timestamp: number;
}

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
let cache: CacheEntry | null = null;

interface LocalRepoItem {
  npub: string;
  repoName: string;
  announcement: NostrEvent | null;
  lastModified: number;
  isRegistered: boolean; // Has this domain in clone URLs
}

const repoRoot = typeof process !== 'undefined' && process.env?.GIT_REPO_ROOT
  ? process.env.GIT_REPO_ROOT
  : '/repos';

/**
 * Scan filesystem for local repositories
 */
async function scanLocalRepos(): Promise<LocalRepoItem[]> {
  const repos: LocalRepoItem[] = [];
  
  if (!existsSync(repoRoot)) {
    return repos;
  }
  
  try {
    // Read all user directories
    const userDirs = await readdir(repoRoot);
    
    for (const userDir of userDirs) {
      const userPath = join(repoRoot, userDir);
      
      // Skip if not a directory or doesn't look like an npub
      if (!userDir.startsWith('npub') || userDir.length < 60) continue;
      
      try {
        const stats = await stat(userPath);
        if (!stats.isDirectory()) continue;
        
        // Read repos for this user
        const repoFiles = await readdir(userPath);
        
        for (const repoFile of repoFiles) {
          if (!repoFile.endsWith('.git')) continue;
          
          const repoName = repoFile.replace(/\.git$/, '');
          const repoPath = join(userPath, repoFile);
          
          try {
            const repoStats = await stat(repoPath);
            if (!repoStats.isDirectory()) continue;
            
            repos.push({
              npub: userDir,
              repoName,
              announcement: null, // Will be fetched later
              lastModified: repoStats.mtime.getTime(),
              isRegistered: false // Will be determined from announcement
            });
          } catch (err) {
            logger.warn({ error: err, repoPath }, 'Failed to stat repo');
          }
        }
      } catch (err) {
        logger.warn({ error: err, userPath }, 'Failed to read user directory');
      }
    }
  } catch (err) {
    logger.error({ error: err }, 'Failed to scan local repos');
    throw err;
  }
  
  return repos;
}

/**
 * Fetch announcements for local repos and check privacy
 */
async function enrichLocalRepos(
  repos: LocalRepoItem[],
  userPubkey: string | null,
  gitDomain: string
): Promise<LocalRepoItem[]> {
  const enriched: LocalRepoItem[] = [];
  
  // Fetch announcements in parallel (batch by owner)
  const ownerMap = new Map<string, string[]>(); // pubkey -> repo names
  for (const repo of repos) {
    try {
      const decoded = nip19.decode(repo.npub);
      if (decoded.type === 'npub') {
        const pubkey = decoded.data as string;
        if (!ownerMap.has(pubkey)) {
          ownerMap.set(pubkey, []);
        }
        ownerMap.get(pubkey)!.push(repo.repoName);
      }
    } catch {
      // Invalid npub, skip
      continue;
    }
  }
  
  // Fetch announcements for each owner
  for (const [pubkey, repoNames] of ownerMap.entries()) {
    try {
      // Fetch all announcements by this author (case-insensitive matching) with caching
      const allEvents = await fetchRepoAnnouncementsWithCache(nostrClient, pubkey, eventCache);
      
      // Match announcements to repos (case-insensitive)
      for (const repo of repos) {
        try {
          const decoded = nip19.decode(repo.npub);
          if (decoded.type !== 'npub' || decoded.data !== pubkey) continue;
          
          const announcement = findRepoAnnouncement(allEvents, repo.repoName);
          
          if (announcement) {
            // Check if registered (has domain in clone URLs)
            const cloneUrls = announcement.tags
              .filter(t => t[0] === 'clone')
              .flatMap(t => t.slice(1))
              .filter(url => url && typeof url === 'string');
            
            const hasDomain = cloneUrls.some(url => url.includes(gitDomain));
            
            // Check privacy
            const isPrivate = announcement.tags.some(t => 
              (t[0] === 'private' && t[1] === 'true') || 
              (t[0] === 't' && t[1] === 'private')
            );
            
            // Check if user can view
            let canView = false;
            if (!isPrivate) {
              canView = true;
            } else if (userPubkey) {
              try {
                canView = await maintainerService.canView(userPubkey, pubkey, repo.repoName);
              } catch (err) {
                logger.warn({ error: err, pubkey, repo: repo.repoName }, 'Failed to check repo access');
                canView = false;
              }
            }
            
            // Only include repos user can view
            if (canView) {
              enriched.push({
                ...repo,
                announcement,
                isRegistered: hasDomain
              });
            }
          } else {
            // No announcement found - only show if user is owner (for security)
            // For now, skip repos without announcements
            // In the future, we could allow owners to see their own repos
          }
        } catch {
          // Skip invalid repos
        }
      }
    } catch (err) {
      logger.warn({ error: err, pubkey }, 'Failed to fetch announcements for owner');
    }
  }
  
  return enriched;
}

export const GET: RequestHandler = async (event) => {
  try {
    const requestContext = extractRequestContext(event);
    const userPubkey = requestContext.userPubkeyHex || null;
    const gitDomain = event.url.searchParams.get('domain') || GIT_DOMAIN;
    const forceRefresh = event.url.searchParams.get('refresh') === 'true';
    
    // Check cache
    if (!forceRefresh && cache && (Date.now() - cache.timestamp) < CACHE_TTL) {
      return json(cache.repos);
    }
    
    // Scan filesystem
    const localRepos = await scanLocalRepos();
    
    // Enrich with announcements and filter by privacy
    const enriched = await enrichLocalRepos(localRepos, userPubkey, gitDomain);
    
    // Filter out registered repos (they're in the main list)
    const unregistered = enriched.filter(r => !r.isRegistered);
    
    // Sort by last modified (most recent first)
    unregistered.sort((a, b) => b.lastModified - a.lastModified);
    
    // Update cache
    cache = {
      repos: unregistered,
      timestamp: Date.now()
    };
    
    return json(unregistered);
  } catch (err) {
    return handleApiError(err, { operation: 'listLocalRepos' }, 'Failed to list local repositories');
  }
};
