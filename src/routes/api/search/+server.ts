/**
 * API endpoint for searching repositories and code
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { NostrClient } from '$lib/services/nostr/nostr-client.js';
import { MaintainerService } from '$lib/services/nostr/maintainer-service.js';
import { DEFAULT_NOSTR_RELAYS, DEFAULT_NOSTR_SEARCH_RELAYS, combineRelays } from '$lib/config.js';
import { KIND } from '$lib/types/nostr.js';
import type { NostrEvent, NostrFilter } from '$lib/types/nostr.js';
import { nip19 } from 'nostr-tools';
import { handleApiError, handleValidationError } from '$lib/utils/error-handler.js';
import { extractRequestContext } from '$lib/utils/api-context.js';
import { resolvePubkey } from '$lib/utils/pubkey-resolver.js';
import { getUserRelays } from '$lib/services/nostr/user-relays.js';
import { eventCache } from '$lib/services/nostr/event-cache.js';
import logger from '$lib/services/logger.js';

// MaintainerService will be created with all available relays per request

export const GET: RequestHandler = async (event) => {
  const query = event.url.searchParams.get('q');
  const limit = parseInt(event.url.searchParams.get('limit') || '20', 10);
  
  // Extract user pubkey for privacy filtering
  const requestContext = extractRequestContext(event);
  const userPubkey = requestContext.userPubkeyHex || null;

  if (!query || query.trim().length === 0) {
    return handleValidationError('Missing or empty query parameter', { operation: 'search' });
  }

  if (query.length < 2) {
    return handleValidationError('Query must be at least 2 characters', { operation: 'search', query });
  }

  try {
    // Collect all available relays
    const allRelays = new Set<string>();
    
    // Add default search relays
    DEFAULT_NOSTR_SEARCH_RELAYS.forEach(relay => allRelays.add(relay));
    DEFAULT_NOSTR_RELAYS.forEach(relay => allRelays.add(relay));
    
    // Add user's relays if logged in
    if (userPubkey) {
      try {
        // Create a temporary client to fetch user relays
        const tempClient = new NostrClient(Array.from(allRelays));
        const userRelays = await getUserRelays(userPubkey, tempClient);
        userRelays.inbox.forEach(relay => allRelays.add(relay));
        userRelays.outbox.forEach(relay => allRelays.add(relay));
      } catch (err) {
        logger.debug({ error: err, userPubkey }, 'Failed to fetch user relays for search');
      }
    }
    
    const relays = Array.from(allRelays);
    logger.debug({ relayCount: relays.length }, 'Using relays for search');
    
    // Create client with all available relays
    const nostrClient = new NostrClient(relays);
    
    // Create maintainer service with all available relays
    const maintainerService = new MaintainerService(relays);
    
    const results: {
      repos: Array<{ 
        id: string; 
        name: string; 
        description: string; 
        owner: string; 
        npub: string;
        maintainers?: Array<{ pubkey: string; isOwner: boolean }>;
      }>;
    } = {
      repos: []
    };

    // Check if query is a URL (clone URL search)
    const isUrl = (str: string): boolean => {
      const trimmed = str.trim();
      return trimmed.startsWith('http://') || 
             trimmed.startsWith('https://') || 
             trimmed.startsWith('git://') ||
             trimmed.startsWith('ssh://') ||
             trimmed.includes('.git') ||
             (trimmed.includes('://') && trimmed.includes('/'));
    };
    
    const queryIsUrl = isUrl(query.trim());
    
    // Check if query is a pubkey (hex, npub, nprofile, or NIP-05)
    const resolvedPubkey = await resolvePubkey(query.trim());
    
    // Helper function to fetch events with cache-first strategy
    async function fetchEventsWithCache(filters: NostrFilter[]): Promise<NostrEvent[]> {
      // Check cache first
      const cachedEvents = eventCache.get(filters);
      if (cachedEvents && cachedEvents.length > 0) {
        logger.debug({ filters, cachedCount: cachedEvents.length }, 'Returning cached events for search');
        
        // Return cached events immediately, fetch from relays in background
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
          // Update cache with merged results
          eventCache.set(filters, mergedEvents);
          logger.debug({ filters, mergedCount: mergedEvents.length }, 'Updated cache with fresh events');
        }).catch(err => {
          logger.debug({ error: err, filters }, 'Background fetch failed, using cached events');
        });
        
        return cachedEvents;
      }
      
      // No cache, fetch from relays
      const freshEvents = await nostrClient.fetchEvents(filters);
      // Cache the results
      if (freshEvents.length > 0) {
        eventCache.set(filters, freshEvents);
      }
      return freshEvents;
    }
    
    let events: NostrEvent[] = [];
    
    if (queryIsUrl) {
      // Search for repos by clone URL
      logger.debug({ query: query.trim() }, 'Searching for repos by clone URL');
      
      // Normalize the URL for matching (remove trailing .git, trailing slash, etc.)
      const normalizeUrl = (url: string): string => {
        let normalized = url.trim().toLowerCase();
        // Remove trailing .git
        if (normalized.endsWith('.git')) {
          normalized = normalized.slice(0, -4);
        }
        // Remove trailing slash
        normalized = normalized.replace(/\/$/, '');
        // Remove protocol for more flexible matching
        normalized = normalized.replace(/^(https?|git|ssh):\/\//, '');
        return normalized;
      };
      
      const normalizedQuery = normalizeUrl(query.trim());
      
      // Fetch all repos with cache-first strategy
      const allRepos = await fetchEventsWithCache([
        {
          kinds: [KIND.REPO_ANNOUNCEMENT],
          limit: 1000 // Get more to find URL matches
        }
      ]);
      
      // Filter for repos that have a matching clone URL
      events = allRepos.filter(event => {
        for (const tag of event.tags) {
          if (tag[0] === 'clone') {
            for (let i = 1; i < tag.length; i++) {
              const cloneUrl = tag[i];
              if (!cloneUrl || typeof cloneUrl !== 'string') continue;
              
              const normalizedCloneUrl = normalizeUrl(cloneUrl);
              
              // Check if the normalized query matches the normalized clone URL
              // Support partial matches (e.g., "example.com/repo" matches "https://example.com/user/repo.git")
              if (normalizedCloneUrl.includes(normalizedQuery) || normalizedQuery.includes(normalizedCloneUrl)) {
                return true;
              }
            }
          }
        }
        return false;
      });
      
    } else if (resolvedPubkey) {
      // Search for repos by owner or maintainer pubkey
      logger.debug({ query: query.trim(), resolvedPubkey }, 'Searching for repos by pubkey');
      
      // Fetch repos where this pubkey is the owner (cache-first)
      const ownerEvents = await fetchEventsWithCache([
        {
          kinds: [KIND.REPO_ANNOUNCEMENT],
          authors: [resolvedPubkey],
          limit: limit * 2
        }
      ]);
      
      // Fetch repos where this pubkey is a maintainer (cache-first)
      // We need to fetch all repos and filter by maintainer tags
      const allRepos = await fetchEventsWithCache([
        {
          kinds: [KIND.REPO_ANNOUNCEMENT],
          limit: 1000 // Get more to find maintainer matches
        }
      ]);
      
      // Filter for repos where resolvedPubkey is in maintainers tag
      const maintainerEvents = allRepos.filter(event => {
        for (const tag of event.tags) {
          if (tag[0] === 'maintainers') {
            for (let i = 1; i < tag.length; i++) {
              const maintainer = tag[i];
              if (!maintainer || typeof maintainer !== 'string') continue;
              
              // Maintainer can be npub or hex pubkey
              let maintainerPubkey = maintainer;
              try {
                const decoded = nip19.decode(maintainer);
                if (decoded.type === 'npub') {
                  maintainerPubkey = decoded.data as string;
                }
              } catch {
                // Assume it's already a hex pubkey
              }
              
              if (maintainerPubkey.toLowerCase() === resolvedPubkey.toLowerCase()) {
                return true;
              }
            }
          }
        }
        return false;
      });
      
      // Combine owner and maintainer events, deduplicate by event ID
      const eventMap = new Map<string, typeof events[0]>();
      ownerEvents.forEach(e => eventMap.set(e.id, e));
      maintainerEvents.forEach(e => eventMap.set(e.id, e));
      events = Array.from(eventMap.values());
      
    } else {
      // Regular text search using NIP-50
      const searchQuery = query.trim().toLowerCase();
      
      // For text search, we'll use cache-first for all repos, then filter
      // This allows us to leverage cache while still supporting NIP-50
      let allReposForTextSearch: NostrEvent[] = [];
      
      // Check cache first for all repo announcements
      const cachedAllRepos = eventCache.get([{ kinds: [KIND.REPO_ANNOUNCEMENT], limit: 1000 }]);
      if (cachedAllRepos && cachedAllRepos.length > 0) {
        logger.debug({ cachedCount: cachedAllRepos.length }, 'Using cached repos for text search');
        allReposForTextSearch = cachedAllRepos;
        
        // Fetch fresh data in background
        nostrClient.fetchEvents([{ kinds: [KIND.REPO_ANNOUNCEMENT], limit: 1000 }]).then(freshRepos => {
          // Merge and update cache
          const eventMap = new Map<string, NostrEvent>();
          cachedAllRepos.forEach(e => eventMap.set(e.id, e));
          freshRepos.forEach(e => {
            const existing = eventMap.get(e.id);
            if (!existing || e.created_at > existing.created_at) {
              eventMap.set(e.id, e);
            }
          });
          const merged = Array.from(eventMap.values());
          eventCache.set([{ kinds: [KIND.REPO_ANNOUNCEMENT], limit: 1000 }], merged);
        }).catch(err => {
          logger.debug({ error: err }, 'Background fetch failed for text search');
        });
      } else {
        // No cache, fetch all repos
        allReposForTextSearch = await nostrClient.fetchEvents([
          { kinds: [KIND.REPO_ANNOUNCEMENT], limit: 1000 }
        ]);
        // Cache the results
        if (allReposForTextSearch.length > 0) {
          eventCache.set([{ kinds: [KIND.REPO_ANNOUNCEMENT], limit: 1000 }], allReposForTextSearch);
        }
      }
      
      try {
        // Try NIP-50 search for fresh results (bypass cache for NIP-50)
        const searchFilter = {
          kinds: [KIND.REPO_ANNOUNCEMENT],
          search: query.trim(), // NIP-50: Search field - use trimmed query
          limit: limit * 2 // Get more results to account for different relay implementations
        };
        
        // Fetch NIP-50 results in background (don't wait)
        const nip50Promise = nostrClient.fetchEvents([searchFilter]).then(nip50Events => {
          // Merge NIP-50 results with cached repos
          const eventMap = new Map<string, NostrEvent>();
          allReposForTextSearch.forEach(e => eventMap.set(e.id, e));
          nip50Events.forEach(e => {
            const existing = eventMap.get(e.id);
            if (!existing || e.created_at > existing.created_at) {
              eventMap.set(e.id, e);
            }
          });
          return Array.from(eventMap.values());
        });
        
        // Filter cached repos immediately for fast results
        const searchLower = searchQuery;
        events = allReposForTextSearch.filter(event => {
          const name = event.tags.find(t => t[0] === 'name')?.[1] || '';
          const description = event.tags.find(t => t[0] === 'description')?.[1] || '';
          const repoId = event.tags.find(t => t[0] === 'd')?.[1] || '';
          const content = event.content || '';

          return name.toLowerCase().includes(searchLower) ||
                 description.toLowerCase().includes(searchLower) ||
                 repoId.toLowerCase().includes(searchLower) ||
                 content.toLowerCase().includes(searchLower);
        });
        
        // Merge NIP-50 results when available (in background)
        nip50Promise.then(mergedEvents => {
          // Update events with NIP-50 results if they're better
          const eventMap = new Map<string, NostrEvent>();
          events.forEach(e => eventMap.set(e.id, e));
          mergedEvents.forEach(e => {
            const existing = eventMap.get(e.id);
            if (!existing || e.created_at > existing.created_at) {
              eventMap.set(e.id, e);
            }
          });
          // Note: We can't update the events array here since it's already being processed
          // The next search will benefit from the updated cache
        }).catch(err => {
          logger.debug({ error: err }, 'NIP-50 search failed, using cached results');
        });
        
        // If NIP-50 returned results, verify they actually match the query
        // Some relays might not properly implement NIP-50 search
        if (events.length > 0) {
          const searchLower = searchQuery;
          events = events.filter(event => {
            const name = event.tags.find(t => t[0] === 'name')?.[1] || '';
            const description = event.tags.find(t => t[0] === 'description')?.[1] || '';
            const repoId = event.tags.find(t => t[0] === 'd')?.[1] || '';
            const content = event.content || '';

            return name.toLowerCase().includes(searchLower) ||
                   description.toLowerCase().includes(searchLower) ||
                   repoId.toLowerCase().includes(searchLower) ||
                   content.toLowerCase().includes(searchLower);
          });
        }
        
        // NIP-50 search succeeded
      } catch (nip50Error) {
        // Fallback to manual filtering if NIP-50 fails or isn't supported
        
        const allEvents = await nostrClient.fetchEvents([
          {
            kinds: [KIND.REPO_ANNOUNCEMENT],
            limit: 500 // Get more events for manual filtering
          }
        ]);
        
        const searchLower = searchQuery;
        events = allEvents.filter(event => {
          const name = event.tags.find(t => t[0] === 'name')?.[1] || '';
          const description = event.tags.find(t => t[0] === 'description')?.[1] || '';
          const repoId = event.tags.find(t => t[0] === 'd')?.[1] || '';
          const content = event.content || '';

          return name.toLowerCase().includes(searchLower) ||
                 description.toLowerCase().includes(searchLower) ||
                 repoId.toLowerCase().includes(searchLower) ||
                 content.toLowerCase().includes(searchLower);
        });
      }
    }
    
    // Process events into results with privacy filtering
    const searchLower = query.trim().toLowerCase();
    
    // Check if this is a pubkey search and if the resolved pubkey matches the logged-in user
    const isSearchingOwnPubkey = resolvedPubkey && userPubkey && 
      resolvedPubkey.toLowerCase() === userPubkey.toLowerCase();
    
    // Map to track repo relationships for sorting
    const repoRelationships = new Map<string, {
      isOwned: boolean;
      isMaintained: boolean;
      isBookmarked: boolean;
      maintainers?: Array<{ pubkey: string; isOwner: boolean }>;
    }>();
    
    // Pre-fetch maintainers and bookmarks for all repos (batch processing)
    const bookmarkChecks = new Map<string, Promise<boolean>>();
    if (userPubkey) {
      const { BookmarksService } = await import('$lib/services/nostr/bookmarks-service.js');
      const bookmarksService = new BookmarksService(relays);
      
      for (const event of events) {
        const repoId = event.tags.find(t => t[0] === 'd')?.[1];
        if (!repoId) continue;
        
        const repoAddress = `${KIND.REPO_ANNOUNCEMENT}:${event.pubkey}:${repoId}`;
        bookmarkChecks.set(event.id, bookmarksService.isBookmarked(userPubkey, repoAddress));
      }
    }
    
    for (const event of events) {
        const repoId = event.tags.find(t => t[0] === 'd')?.[1];
        if (!repoId) continue;
        
        // Check privacy
        const isPrivate = event.tags.some(t => 
          (t[0] === 'private' && t[1] === 'true') || 
          (t[0] === 't' && t[1] === 'private')
        );
        
        // Check if user can view this repo
        let canView = false;
        if (!isPrivate) {
          canView = true; // Public repos are viewable by anyone
        } else {
          // Private repos require authentication
          
          // Special case: if searching by pubkey and the resolved pubkey matches the logged-in user,
          // show all their repos (public and private) regardless of who owns them
          if (isSearchingOwnPubkey && resolvedPubkey) {
            // Check if the logged-in user is the owner or maintainer of this repo
            try {
              // Check if user is owner (event.pubkey matches resolvedPubkey)
              if (event.pubkey.toLowerCase() === resolvedPubkey.toLowerCase()) {
                canView = true; // User owns this repo
              } else {
                // Check if user is a maintainer
                const { maintainers } = await maintainerService.getMaintainers(event.pubkey, repoId);
                if (maintainers.some(m => m.toLowerCase() === resolvedPubkey.toLowerCase())) {
                  canView = true; // User is a maintainer
                }
              }
            } catch (err) {
              logger.warn({ error: err, pubkey: event.pubkey, repo: repoId }, 'Failed to check maintainer status in pubkey search');
              canView = false;
            }
          } else if (userPubkey) {
            // Regular privacy check: check if logged-in user owns, maintains, or has bookmarked
            try {
              // Check if user is owner or maintainer
              canView = await maintainerService.canView(userPubkey, event.pubkey, repoId);
              
              // If not owner/maintainer, check if user has bookmarked it
              if (!canView) {
                const { BookmarksService } = await import('$lib/services/nostr/bookmarks-service.js');
                const bookmarksService = new BookmarksService(relays);
                const repoAddress = `${KIND.REPO_ANNOUNCEMENT}:${event.pubkey}:${repoId}`;
                canView = await bookmarksService.isBookmarked(userPubkey, repoAddress);
              }
            } catch (err) {
              logger.warn({ error: err, pubkey: event.pubkey, repo: repoId }, 'Failed to check repo access in search');
              canView = false;
            }
          }
          // If no userPubkey and repo is private, canView remains false
        }
        
        // Only include repos the user can view
        if (!canView) continue;
        
        const name = event.tags.find(t => t[0] === 'name')?.[1] || '';
        const description = event.tags.find(t => t[0] === 'description')?.[1] || '';

        try {
          const npub = nip19.npubEncode(event.pubkey);
          
          // Determine relationship to user
          const isOwned = !!(userPubkey && event.pubkey.toLowerCase() === userPubkey.toLowerCase());
          let isMaintained = false;
          let allMaintainers: Array<{ pubkey: string; isOwner: boolean }> = [];
          
          // Fetch maintainers for this repo
          try {
            const { maintainers, owner } = await maintainerService.getMaintainers(event.pubkey, repoId);
            
            // Build maintainers list with owner flag, owner first
            // The maintainers array from getMaintainers always includes the owner as the first element
            // Use a Set to track which pubkeys we've already added (case-insensitive)
            const seenPubkeys = new Set<string>();
            const ownerLower = owner.toLowerCase();
            
            // Build the list: owner first, then other maintainers
            allMaintainers = [];
            
            // Process all maintainers, marking owner and deduplicating
            for (const maintainer of maintainers) {
              const maintainerLower = maintainer.toLowerCase();
              
              // Skip if we've already added this pubkey (case-insensitive check)
              if (seenPubkeys.has(maintainerLower)) {
                continue;
              }
              
              // Mark as seen
              seenPubkeys.add(maintainerLower);
              
              // Determine if this is the owner
              const isOwner = maintainerLower === ownerLower;
              
              // Add to list
              allMaintainers.push({ 
                pubkey: maintainer, 
                isOwner 
              });
            }
            
            // Sort: owner first, then other maintainers
            allMaintainers.sort((a, b) => {
              if (a.isOwner && !b.isOwner) return -1;
              if (!a.isOwner && b.isOwner) return 1;
              return 0;
            });
            
            // Ensure owner is always included (in case they weren't in maintainers list)
            const hasOwner = allMaintainers.some(m => m.pubkey.toLowerCase() === ownerLower);
            if (!hasOwner) {
              allMaintainers.unshift({ pubkey: owner, isOwner: true });
            }
            
            // Check if user is a maintainer (but not owner, since we already checked that)
            if (userPubkey && !isOwned) {
              isMaintained = maintainers.some(m => m.toLowerCase() === userPubkey.toLowerCase());
            }
          } catch (err) {
            logger.warn({ error: err, pubkey: event.pubkey, repo: repoId }, 'Failed to fetch maintainers for search result');
            // Fallback: just use owner
            allMaintainers = [{ pubkey: event.pubkey, isOwner: true }];
          }
          
          // Check if bookmarked
          let isBookmarked = false;
          if (userPubkey && bookmarkChecks.has(event.id)) {
            const bookmarkCheck = bookmarkChecks.get(event.id);
            if (bookmarkCheck) {
              isBookmarked = await bookmarkCheck;
            }
          }
          
          // Store relationship for sorting
          repoRelationships.set(event.id, {
            isOwned,
            isMaintained,
            isBookmarked,
            maintainers: allMaintainers
          });
          
          results.repos.push({
            id: event.id,
            name: name || repoId,
            description: description || '',
            owner: event.pubkey,
            npub,
            maintainers: allMaintainers
          });
        } catch {
          // Skip if npub encoding fails
        }
      }

      // Sort by user relationship priority, then by relevance
      // Priority: owned > maintained > bookmarked > others
      // Within each group, sort by relevance (name matches first, then description)
      results.repos.sort((a, b) => {
        const aRel = repoRelationships.get(a.id) || { isOwned: false, isMaintained: false, isBookmarked: false };
        const bRel = repoRelationships.get(b.id) || { isOwned: false, isMaintained: false, isBookmarked: false };
        
        // Priority 1: Owned repos first
        if (aRel.isOwned && !bRel.isOwned) return -1;
        if (!aRel.isOwned && bRel.isOwned) return 1;
        
        // Priority 2: Maintained repos (but not owned)
        if (!aRel.isOwned && !bRel.isOwned) {
          if (aRel.isMaintained && !bRel.isMaintained) return -1;
          if (!aRel.isMaintained && bRel.isMaintained) return 1;
        }
        
        // Priority 3: Bookmarked repos (but not owned or maintained)
        if (!aRel.isOwned && !aRel.isMaintained && !bRel.isOwned && !bRel.isMaintained) {
          if (aRel.isBookmarked && !bRel.isBookmarked) return -1;
          if (!aRel.isBookmarked && bRel.isBookmarked) return 1;
        }
        
        // Priority 4: Relevance (name matches first, then description)
        const aNameMatch = a.name.toLowerCase().includes(searchLower);
        const bNameMatch = b.name.toLowerCase().includes(searchLower);
        if (aNameMatch && !bNameMatch) return -1;
        if (!aNameMatch && bNameMatch) return 1;
        
        const aDescMatch = a.description.toLowerCase().includes(searchLower);
        const bDescMatch = b.description.toLowerCase().includes(searchLower);
        if (aDescMatch && !bDescMatch) return -1;
        if (!aDescMatch && bDescMatch) return 1;
        
        return 0;
      });

    results.repos = results.repos.slice(0, limit);

    return json({
      query,
      results,
      total: results.repos.length
    });
  } catch (err) {
    return handleApiError(err, { operation: 'search', query }, 'Failed to search');
  }
};
