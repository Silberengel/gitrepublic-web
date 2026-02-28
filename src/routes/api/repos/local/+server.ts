/**
 * API endpoint for listing local repository clones
 * Returns local repos with their announcements, filtered by privacy
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readdir, stat } from 'fs/promises';
import { join, resolve } from 'path';
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

/**
 * Read announcement from filesystem (nostr/repo-events.jsonl)
 * Returns null if not found or on error
 */
async function readAnnouncementFromFilesystem(npub: string, repoName: string): Promise<NostrEvent | null> {
  // Guard against client-side execution
  if (typeof process === 'undefined' || typeof process.env === 'undefined') {
    return null;
  }
  
  try {
    const repoPath = join(repoRoot, npub, `${repoName}.git`);
    if (!existsSync(repoPath)) {
      return null;
    }
    
    const { simpleGit } = await import('simple-git');
    const git = simpleGit(repoPath);
    
    // Get the most recent commit that modified repo-events.jsonl
    const logOutput = await git.raw(['log', '--all', '--format=%H', '--reverse', '--', 'nostr/repo-events.jsonl']).catch(() => '');
    const commitHashes = logOutput.trim().split('\n').filter(Boolean);
    
    if (commitHashes.length === 0) {
      return null;
    }
    
    const mostRecentCommit = commitHashes[commitHashes.length - 1];
    
    // Read the file content from git
    const fileContent = await git.show([`${mostRecentCommit}:nostr/repo-events.jsonl`]).catch(() => null);
    
    if (!fileContent) {
      return null;
    }
    
    // Parse repo-events.jsonl to find the most recent announcement
    let announcementEvent: NostrEvent | null = null;
    let latestTimestamp = 0;
    
    try {
      const lines = fileContent.trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'announcement' && entry.event && entry.timestamp) {
            if (entry.timestamp > latestTimestamp) {
              latestTimestamp = entry.timestamp;
              announcementEvent = entry.event;
            }
          }
        } catch {
          continue;
        }
      }
    } catch (parseError) {
      logger.debug({ error: parseError, npub, repoName }, 'Failed to parse repo-events.jsonl');
      return null;
    }
    
    if (!announcementEvent) {
      return null;
    }
    
    // Validate the announcement (case-insensitive repo name matching)
    const dTag = announcementEvent.tags.find(t => t[0] === 'd')?.[1];
    
    // Check if d-tag matches repo name (case-insensitive)
    if (!dTag || dTag.toLowerCase() !== repoName.toLowerCase()) {
      logger.debug({ npub, repoName, dTag }, 'Announcement d-tag does not match repo name (case-insensitive)');
      return null;
    }
    
    const { validateAnnouncementEvent } = await import('$lib/services/nostr/repo-verification.js');
    const validation = validateAnnouncementEvent(announcementEvent, repoName);
    
    if (!validation.valid) {
      logger.debug({ error: validation.error, npub, repoName }, 'Announcement validation failed');
      return null;
    }
    
    return announcementEvent;
  } catch (error) {
    logger.debug({ error, npub, repoName }, 'Error reading announcement from filesystem');
    return null;
  }
}

// Cache for local repo list (5 minute TTL)
interface CacheEntry {
  repos: LocalRepoItem[];
  timestamp: number;
}

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
let cache: CacheEntry | null = null;

// Track server startup time to invalidate cache on first request after startup
let serverStartTime = Date.now();
const STARTUP_GRACE_PERIOD = 1000; // 1 second - minimal grace period for cache

/**
 * Invalidate cache (internal use only - not exported to avoid SvelteKit build errors)
 */
function invalidateLocalReposCache(): void {
  cache = null;
  serverStartTime = Date.now();
  logger.debug('Local repos cache invalidated');
}

interface LocalRepoItem {
  npub: string;
  repoName: string;
  announcement: NostrEvent | null;
  lastModified: number;
  isRegistered: boolean; // Has this domain in clone URLs
}

// Resolve GIT_REPO_ROOT to absolute path (handles both relative and absolute paths)
const repoRootEnv = typeof process !== 'undefined' && process.env?.GIT_REPO_ROOT
  ? process.env.GIT_REPO_ROOT
  : '/repos';
const repoRoot = resolve(repoRootEnv);

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
            // No announcement found in relays - try reading from filesystem
            // This is important for private forks that weren't published to relays
            try {
              const { fileManager } = await import('$lib/services/service-registry.js');
              // Read announcement from repo-events.jsonl file
              const announcementFromRepo = await readAnnouncementFromFilesystem(repo.npub, repo.repoName);
              
              if (announcementFromRepo) {
                // Check if registered (has domain in clone URLs)
                const cloneUrls = announcementFromRepo.tags
                  .filter(t => t[0] === 'clone')
                  .flatMap(t => t.slice(1))
                  .filter(url => url && typeof url === 'string');
                
                const hasDomain = cloneUrls.some(url => url.includes(gitDomain));
                
                // Check privacy
                const isPrivate = announcementFromRepo.tags.some(t => 
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
                    logger.warn({ error: err, pubkey, repo: repo.repoName }, 'Failed to check repo access for filesystem announcement');
                    canView = false;
                  }
                }
                
                // Only include repos user can view
                if (canView) {
                  enriched.push({
                    ...repo,
                    announcement: announcementFromRepo,
                    isRegistered: hasDomain
                  });
                  logger.debug({ npub: repo.npub, repo: repo.repoName }, 'Found announcement in filesystem for local repo');
                }
              }
            } catch (err) {
              logger.debug({ error: err, npub: repo.npub, repo: repo.repoName }, 'Failed to read announcement from filesystem');
              // Continue - repo won't be included if no announcement found
            }
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
    
    // If server just started, always refresh to ensure we get latest repos
    const timeSinceStartup = Date.now() - serverStartTime;
    const isRecentStartup = timeSinceStartup < STARTUP_GRACE_PERIOD;
    
    // Check cache (but skip if recent startup or force refresh)
    if (!forceRefresh && !isRecentStartup && cache && (Date.now() - cache.timestamp) < CACHE_TTL) {
      return json(cache.repos);
    }
    
    if (isRecentStartup) {
      logger.debug({ timeSinceStartup }, 'Skipping cache due to recent server startup');
    }
    
    // Scan filesystem
    let localRepos: LocalRepoItem[] = [];
    try {
      localRepos = await scanLocalRepos();
    } catch (scanError) {
      logger.error({ error: scanError }, 'Failed to scan local repos, returning empty list');
      // Return empty list instead of failing
      return json([]);
    }
    
    // Enrich with announcements and filter by privacy
    let enriched: LocalRepoItem[] = [];
    try {
      enriched = await enrichLocalRepos(localRepos, userPubkey, gitDomain);
    } catch (enrichError) {
      logger.error({ error: enrichError }, 'Failed to enrich local repos, returning scanned repos without announcements');
      // Return repos without announcements rather than failing completely
      enriched = localRepos;
    }
    
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
