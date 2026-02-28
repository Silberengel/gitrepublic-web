/**
 * API endpoint for listing repositories with privacy checks
 * Returns only repositories the current user can view
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
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
import { existsSync } from 'fs';
import { readdir, stat } from 'fs/promises';
import { join, resolve } from 'path';
import { eventCache } from '$lib/services/nostr/event-cache.js';
import { fetchRepoAnnouncementsWithCache, findRepoAnnouncement } from '$lib/utils/nostr-utils.js';
import { simpleGit } from 'simple-git';

const nostrClient = new NostrClient(DEFAULT_NOSTR_RELAYS);
const maintainerService = new MaintainerService(DEFAULT_NOSTR_RELAYS);

const repoRoot = typeof process !== 'undefined' && process.env?.GIT_REPO_ROOT
  ? resolve(process.env.GIT_REPO_ROOT)
  : resolve('/repos');

interface RepoListItem {
  event: NostrEvent;
  npub: string;
  repoName: string;
  isRegistered: boolean; // Has this domain in clone URLs
}

/**
 * Read announcement from filesystem (nostr/repo-events.jsonl)
 * Returns null if not found or on error
 */
async function readAnnouncementFromFilesystem(npub: string, repoName: string, expectedPubkey: string): Promise<NostrEvent | null> {
  try {
    const repoPath = join(repoRoot, npub, `${repoName}.git`);
    if (!existsSync(repoPath)) {
      return null;
    }
    
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
            // Verify the announcement is for the expected pubkey
            if (entry.event.pubkey === expectedPubkey) {
              if (entry.timestamp > latestTimestamp) {
                latestTimestamp = entry.timestamp;
                announcementEvent = entry.event;
              }
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
    
    // Validate the announcement
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

export const GET: RequestHandler = async (event) => {
  try {
    const requestContext = extractRequestContext(event);
    const userPubkey = requestContext.userPubkeyHex || null;
    const gitDomain = event.url.searchParams.get('domain') || GIT_DOMAIN;
    
    // Fetch all repository announcements from Nostr relays
    const events = await nostrClient.fetchEvents([
      { kinds: [KIND.REPO_ANNOUNCEMENT], limit: 100 }
    ]);

    const repos: RepoListItem[] = [];
    const processedRepos = new Set<string>(); // Track processed repos to avoid duplicates
    
    // Process each announcement from Nostr
    for (const event of events) {
      const cloneUrls = event.tags
        .filter(t => t[0] === 'clone')
        .flatMap(t => t.slice(1))
        .filter(url => url && typeof url === 'string');
      
      // Check if repo has this domain in clone URLs
      const hasDomain = cloneUrls.some(url => url.includes(gitDomain));
      
      // Extract repo name from d-tag
      const dTag = event.tags.find(t => t[0] === 'd')?.[1];
      if (!dTag) continue;
      
      // Check privacy
      const isPrivate = event.tags.some(t => 
        (t[0] === 'private' && t[1] === 'true') || 
        (t[0] === 't' && t[1] === 'private')
      );
      
      // Check if user can view this repo
      let canView = false;
      if (!isPrivate) {
        canView = true; // Public repos are viewable by anyone
      } else if (userPubkey) {
        // Private repos require authentication
        try {
          canView = await maintainerService.canView(userPubkey, event.pubkey, dTag);
        } catch (err) {
          logger.warn({ error: err, pubkey: event.pubkey, repo: dTag }, 'Failed to check repo access');
          canView = false;
        }
      }
      
      // Only include repos the user can view
      if (!canView) continue;
      
      // Extract npub from clone URLs or convert pubkey
      let npub: string;
      const domainUrl = cloneUrls.find(url => url.includes(gitDomain));
      if (domainUrl) {
        const match = domainUrl.match(/\/(npub[a-z0-9]+)\//);
        if (match) {
          npub = match[1];
        } else {
          npub = nip19.npubEncode(event.pubkey);
        }
      } else {
        npub = nip19.npubEncode(event.pubkey);
      }
      
      // Only include repos that actually exist locally on the server
      // This ensures deleted repos don't show up in the list
      const repoPath = join(repoRoot, npub, `${dTag}.git`);
      if (!existsSync(repoPath)) {
        logger.debug({ npub, repoName: dTag, repoPath }, 'Skipping repo - does not exist locally');
        continue;
      }
      
      repos.push({
        event,
        npub,
        repoName: dTag,
        isRegistered: hasDomain
      });
      processedRepos.add(`${npub}/${dTag}`);
    }
    
    // Also check filesystem for repos that might not be in Nostr (e.g., private forks)
    // Scan local repos and check if they have announcements
    if (existsSync(repoRoot)) {
      try {
        const userDirs = await readdir(repoRoot);
        
        for (const userDir of userDirs) {
          if (!userDir.startsWith('npub') || userDir.length < 60) continue;
          
          try {
            const userPath = join(repoRoot, userDir);
            const stats = await stat(userPath);
            if (!stats.isDirectory()) continue;
            
            const repoFiles = await readdir(userPath);
            
            for (const repoFile of repoFiles) {
              if (!repoFile.endsWith('.git')) continue;
              
              const repoName = repoFile.replace(/\.git$/, '');
              const repoKey = `${userDir}/${repoName}`;
              
              // Skip if already processed from Nostr
              if (processedRepos.has(repoKey)) continue;
              
              try {
                // Decode npub to get pubkey
                const decoded = nip19.decode(userDir);
                if (decoded.type !== 'npub') continue;
                const ownerPubkey = decoded.data as string;
                
                // Try to read announcement from filesystem
                const announcementFromRepo = await readAnnouncementFromFilesystem(userDir, repoName, ownerPubkey);
                
                if (announcementFromRepo) {
                  // Check if repo has this domain in clone URLs
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
                  
                  // Check if user can view this repo
                  let canView = false;
                  if (!isPrivate) {
                    canView = true; // Public repos are viewable by anyone
                  } else if (userPubkey) {
                    // Private repos require authentication
                    try {
                      canView = await maintainerService.canView(userPubkey, ownerPubkey, repoName);
                    } catch (err) {
                      logger.debug({ error: err, pubkey: ownerPubkey, repo: repoName }, 'Failed to check repo access for filesystem announcement');
                      canView = false;
                    }
                  }
                  
                  // Only include repos the user can view
                  if (canView) {
                    repos.push({
                      event: announcementFromRepo,
                      npub: userDir,
                      repoName,
                      isRegistered: hasDomain
                    });
                    processedRepos.add(repoKey);
                    logger.debug({ npub: userDir, repo: repoName }, 'Added repo from filesystem to list');
                  }
                }
              } catch (err) {
                logger.debug({ error: err, npub: userDir, repo: repoName }, 'Failed to process repo from filesystem');
              }
            }
          } catch (err) {
            logger.debug({ error: err, userDir }, 'Failed to read user directory');
          }
        }
      } catch (err) {
        logger.warn({ error: err }, 'Failed to scan filesystem for repos');
      }
    }
    
    // Only return registered repos (repos with this domain in clone URLs)
    const registered = repos.filter(r => r.isRegistered);
    
    // Sort by created_at descending
    registered.sort((a, b) => b.event.created_at - a.event.created_at);
    
    return json({
      registered,
      total: registered.length
    });
  } catch (err) {
    return handleApiError(err, { operation: 'listRepos' }, 'Failed to list repositories');
  }
};
