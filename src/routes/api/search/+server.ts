/**
 * API endpoint for searching repositories
 * Cache-first with parallel relay queries (normal filters + NIP-50)
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { NostrClient } from '$lib/services/nostr/nostr-client.js';
import { MaintainerService } from '$lib/services/nostr/maintainer-service.js';
import { DEFAULT_NOSTR_SEARCH_RELAYS, DEFAULT_NOSTR_RELAYS } from '$lib/config.js';
import { KIND } from '$lib/types/nostr.js';
import type { NostrEvent, NostrFilter } from '$lib/types/nostr.js';
import { nip19 } from 'nostr-tools';
import { handleApiError, handleValidationError } from '$lib/utils/error-handler.js';
import { extractRequestContext } from '$lib/utils/api-context.js';
import { resolvePubkey } from '$lib/utils/pubkey-resolver.js';
import { getUserRelays } from '$lib/services/nostr/user-relays.js';
import { eventCache } from '$lib/services/nostr/event-cache.js';
import { decodeNostrAddress } from '$lib/services/nostr/nip19-utils.js';
import logger from '$lib/services/logger.js';
import { isParameterizedReplaceable } from '$lib/utils/nostr-event-utils.js';
import { readdir, stat } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { simpleGit } from 'simple-git';
import { fileManager } from '$lib/services/service-registry.js';

// Replaceable event kinds (only latest per pubkey matters)
const REPLACEABLE_KINDS = [0, 3, 10002]; // Profile, Contacts, Relay List

/**
 * Get the deduplication key for an event
 * For replaceable events: kind:pubkey
 * For parameterized replaceable events: kind:pubkey:d-tag
 * For regular events: event.id
 */
function getDeduplicationKey(event: NostrEvent): string {
  if (REPLACEABLE_KINDS.includes(event.kind)) {
    return `${event.kind}:${event.pubkey}`;
  }
  if (isParameterizedReplaceable(event)) {
    const dTag = event.tags.find(t => t[0] === 'd')?.[1] || '';
    return `${event.kind}:${event.pubkey}:${dTag}`;
  }
  // Special handling for gitrepublic-write-proof kind 24 events - treat as replaceable
  if (event.kind === KIND.PUBLIC_MESSAGE && event.content && event.content.includes('gitrepublic-write-proof')) {
    return `24:${event.pubkey}:write-proof`;
  }
  return event.id;
}

export const GET: RequestHandler = async (event) => {
  const query = event.url.searchParams.get('q');
  const type = event.url.searchParams.get('type') || 'repos'; // Default to repos search
  const limit = parseInt(event.url.searchParams.get('limit') || (type === 'code' ? '100' : '20'), 10);
  const repoFilter = event.url.searchParams.get('repo'); // For code search: filter by specific repo (npub/repo format)
  
  // Extract user pubkey for privacy filtering
  const requestContext = extractRequestContext(event);
  const userPubkey = requestContext.userPubkeyHex || null;

  if (!query || query.trim().length === 0) {
    return handleValidationError('Missing or empty query parameter', { operation: 'search' });
  }

  if (query.length < 2) {
    return handleValidationError('Query must be at least 2 characters', { operation: 'search', query });
  }

  // If type is 'code', delegate to code search logic
  if (type === 'code') {
    return handleCodeSearch(event, query, limit, repoFilter, requestContext);
  }

  // Otherwise, continue with repository search (type === 'repos' or default)

  try {
    // Collect all available relays - prioritize DEFAULT_NOSTR_SEARCH_RELAYS
    const allRelays = new Set<string>();
    DEFAULT_NOSTR_SEARCH_RELAYS.forEach(relay => allRelays.add(relay));
    
    // Add user's relays if logged in
    if (userPubkey) {
      try {
        const tempClient = new NostrClient(Array.from(allRelays));
        const userRelays = await getUserRelays(userPubkey, tempClient);
        userRelays.inbox.forEach(relay => allRelays.add(relay));
        userRelays.outbox.forEach(relay => allRelays.add(relay));
      } catch (err) {
        logger.debug({ error: err, userPubkey }, 'Failed to fetch user relays for search');
      }
    }
    
    const relays = [
      ...DEFAULT_NOSTR_SEARCH_RELAYS,
      ...Array.from(allRelays).filter(r => !DEFAULT_NOSTR_SEARCH_RELAYS.includes(r))
    ];
    
    logger.info({ 
      relayCount: relays.length, 
      query: query.trim().substring(0, 50),
      hasUserPubkey: !!userPubkey 
    }, 'Starting search');
    
    // Create client with all available relays (no throttling for read operations)
    const nostrClient = new NostrClient(relays);
    const maintainerService = new MaintainerService(relays);
    
    // Step 1: Check cache and return results immediately
    const cacheKey = [{ kinds: [KIND.REPO_ANNOUNCEMENT], limit: 1000 }];
    const cachedRepos = eventCache.get(cacheKey) || [];
    
    logger.debug({ cachedReposCount: cachedRepos.length, query: query.trim().substring(0, 50) }, 'Cache check');
    
    // Normalize query for searching
    const queryLower = query.trim().toLowerCase();
    const queryTrimmed = query.trim();
    
    // Try to resolve query as various identifiers
    let resolvedPubkey: string | null = null;
    let decodedAddress: ReturnType<typeof decodeNostrAddress> | null = null;
    
    // Try to resolve as pubkey (npub, nprofile, hex, nip-05)
    try {
      resolvedPubkey = await resolvePubkey(queryTrimmed);
      if (resolvedPubkey) {
        logger.debug({ query: queryTrimmed.substring(0, 50), resolvedPubkey: resolvedPubkey.substring(0, 16) + '...' }, 'Resolved query as pubkey');
      }
    } catch {
      // Not a pubkey, continue
    }
    
    // Try to decode as naddr, nevent, note1
    decodedAddress = decodeNostrAddress(queryTrimmed);
    if (decodedAddress) {
      logger.debug({ query: queryTrimmed.substring(0, 50), decodedType: decodedAddress.type }, 'Decoded query as address');
    }
    
    // Filter cached repos based on query
    const cachedResults = filterRepos(cachedRepos, queryTrimmed, queryLower, resolvedPubkey, decodedAddress);
    logger.debug({ cachedResultsCount: cachedResults.length, cachedReposCount: cachedRepos.length }, 'Cached results filtered');
    
    // Step 2 & 3: Fetch from relays in parallel (normal filters + NIP-50) with 10s timeout
    // Start relay fetch in background - don't wait for it, return cached results immediately
    logger.debug({ query: queryTrimmed.substring(0, 50), relayCount: relays.length }, 'Starting relay fetch in background');
    const relayFetchPromise = Promise.race([
      fetchFromRelays(nostrClient, queryTrimmed, queryLower, resolvedPubkey, decodedAddress, limit).then(result => {
        logger.debug({ 
          query: queryTrimmed.substring(0, 50),
          filteredCount: result.filtered.length,
          allReposCount: result.allRepos.length
        }, 'Relay fetch completed');
        return result;
      }),
      new Promise<{ filtered: NostrEvent[]; allRepos: NostrEvent[] }>((resolve) => {
        setTimeout(() => {
          logger.debug({ query: queryTrimmed.substring(0, 50) }, 'Relay fetch timeout (10s)');
          resolve({ filtered: [], allRepos: [] });
        }, 10000); // Increased to 10s to allow querySync to complete
      })
    ]).catch(err => {
      logger.debug({ error: err, query: queryTrimmed.substring(0, 50) }, 'Relay fetch error');
      return { filtered: [], allRepos: [] };
    });
    
    // Wait for relay results (already has timeout built in)
    let relayResults: NostrEvent[] = [];
    let allRelayRepos: NostrEvent[] = [];
    
    try {
      const relayResult = await relayFetchPromise;
      relayResults = relayResult.filtered;
      allRelayRepos = relayResult.allRepos;
    } catch (err) {
      logger.debug({ error: err }, 'Failed to get relay results');
    }
    
    // Step 4 & 5: Deduplicate results (cached + relay) using deduplication keys
    // For replaceable/parameterized replaceable events, use kind:pubkey:d-tag as key
    // For regular events, use event.id as key
    const allResults = new Map<string, NostrEvent>();
    
    // Add cached results first, using deduplication keys
    cachedResults.forEach(r => {
      const key = getDeduplicationKey(r);
      const existing = allResults.get(key);
      if (!existing || r.created_at > existing.created_at) {
        allResults.set(key, r);
      }
    });
    
    // Add relay results (prefer newer events), using deduplication keys
    relayResults.forEach(r => {
      const key = getDeduplicationKey(r);
      const existing = allResults.get(key);
      if (!existing || r.created_at > existing.created_at) {
        allResults.set(key, r);
      }
    });
    
    // Step 6: Update cache with ALL repos found from relays (not just filtered ones)
    // This ensures everything discovered during the search is cached for future use
    // Use deduplication keys to ensure only the newest event per kind:pubkey:d-tag is cached
    if (allRelayRepos.length > 0) {
      const repoMap = new Map<string, NostrEvent>();
      // Start with cached repos, using deduplication keys
      cachedRepos.forEach(r => {
        const key = getDeduplicationKey(r);
        const existing = repoMap.get(key);
        if (!existing || r.created_at > existing.created_at) {
          repoMap.set(key, r);
        }
      });
      // Add ALL repos found from relays (prefer newer events), using deduplication keys
      allRelayRepos.forEach(r => {
        const key = getDeduplicationKey(r);
        const existing = repoMap.get(key);
        if (!existing || r.created_at > existing.created_at) {
          repoMap.set(key, r);
        }
      });
      // Update cache with merged results
      eventCache.set(cacheKey, Array.from(repoMap.values()));
      logger.debug({ 
        cachedCount: cachedRepos.length,
        relayReposCount: allRelayRepos.length,
        filteredCount: relayResults.length,
        finalCacheCount: repoMap.size
      }, 'Cache updated with all repos found from relays');
    } else if (relayResults.length > 0) {
      // Fallback: if we only have filtered results, cache those
      const repoMap = new Map<string, NostrEvent>();
      cachedRepos.forEach(r => {
        const key = getDeduplicationKey(r);
        const existing = repoMap.get(key);
        if (!existing || r.created_at > existing.created_at) {
          repoMap.set(key, r);
        }
      });
      relayResults.forEach(r => {
        const key = getDeduplicationKey(r);
        const existing = repoMap.get(key);
        if (!existing || r.created_at > existing.created_at) {
          repoMap.set(key, r);
        }
      });
      eventCache.set(cacheKey, Array.from(repoMap.values()));
      logger.debug({ 
        cachedCount: cachedRepos.length,
        filteredCount: relayResults.length,
        finalCacheCount: repoMap.size
      }, 'Cache updated with filtered relay results (no unfiltered repos available)');
    }
    
    const mergedResults = Array.from(allResults.values());
    
    logger.debug({ 
      cachedCount: cachedResults.length,
      relayCount: relayResults.length,
      mergedCount: mergedResults.length
    }, 'Search results merged');
    
    // Step 6: Process results with privacy filtering
    const results: Array<{
      id: string;
      name: string;
      description: string;
      owner: string;
      npub: string;
      repoId?: string;
      maintainers?: Array<{ pubkey: string; isOwner: boolean }>;
      announcement?: NostrEvent;
    }> = [];
    
    logger.debug({ 
      mergedResultsCount: mergedResults.length,
      processingCount: Math.min(mergedResults.length, limit * 2)
    }, 'Processing merged results for privacy filtering');
    
    for (const event of mergedResults.slice(0, limit * 2)) { // Get more to filter by privacy
      const repoId = event.tags.find(t => t[0] === 'd')?.[1];
      if (!repoId) {
        logger.debug({ eventId: event.id }, 'Skipping event without d-tag');
        continue;
      }
      
      // Check privacy
      const isPrivate = event.tags.some(t => 
        (t[0] === 'private' && t[1] === 'true') || 
        (t[0] === 't' && t[1] === 'private')
      );
      
      // Check if user can view
      let canView = !isPrivate; // Public repos are viewable by anyone
      
      if (isPrivate && userPubkey) {
        try {
          canView = await maintainerService.canView(userPubkey, event.pubkey, repoId);
        } catch (err) {
          logger.debug({ error: err }, 'Failed to check repo access');
          canView = false;
        }
      }
      
      if (!canView) {
        logger.debug({ eventId: event.id, repoId, isPrivate, hasUserPubkey: !!userPubkey }, 'Skipping event - cannot view');
        continue;
      }
      
      const name = event.tags.find(t => t[0] === 'name')?.[1] || repoId;
      const description = event.tags.find(t => t[0] === 'description')?.[1] || '';
      
      try {
        const npub = nip19.npubEncode(event.pubkey);
        
        // Get maintainers
        let allMaintainers: Array<{ pubkey: string; isOwner: boolean }> = [];
        try {
          const { maintainers, owner } = await maintainerService.getMaintainers(event.pubkey, repoId);
          const ownerLower = owner.toLowerCase();
          const seenPubkeys = new Set<string>();
          
          for (const maintainer of maintainers) {
            const maintainerLower = maintainer.toLowerCase();
            if (seenPubkeys.has(maintainerLower)) continue;
            seenPubkeys.add(maintainerLower);
            allMaintainers.push({
              pubkey: maintainer,
              isOwner: maintainerLower === ownerLower
            });
          }
          
          allMaintainers.sort((a, b) => {
            if (a.isOwner && !b.isOwner) return -1;
            if (!a.isOwner && b.isOwner) return 1;
            return 0;
          });
        } catch (err) {
          logger.debug({ error: err }, 'Failed to fetch maintainers');
          allMaintainers = [{ pubkey: event.pubkey, isOwner: true }];
        }
        
        results.push({
          id: event.id,
          name,
          description,
          owner: event.pubkey,
          npub,
          repoId,
          maintainers: allMaintainers,
          announcement: event
        });
        logger.debug({ eventId: event.id, repoId, name }, 'Added repo to results');
      } catch (err) {
        // Skip if npub encoding fails
        logger.debug({ error: err, eventId: event.id, repoId }, 'Skipping event - npub encoding failed');
      }
    }
    
    // Limit results
    const limitedResults = results.slice(0, limit);
    
    // Determine if we're showing cached results (relays still being checked)
    const fromCache = cachedResults.length > 0 && relayResults.length === 0;
    
    logger.info({ 
      query: queryTrimmed.substring(0, 50),
      resultCount: limitedResults.length,
      totalMatches: mergedResults.length,
      fromCache
    }, 'Search completed');
    
    return json({
      query: queryTrimmed,
      results: {
        repos: limitedResults
      },
      total: limitedResults.length,
      fromCache: fromCache // Indicate if results are from cache (relays may still be checking)
    });
  } catch (err) {
    return handleApiError(err, { operation: 'search', query }, 'Failed to search');
  }
};

/**
 * Fetch from relays using normal filters and NIP-50 search in parallel
 * Returns both filtered results and all unfiltered repos for caching
 */
async function fetchFromRelays(
  nostrClient: NostrClient,
  queryTrimmed: string,
  queryLower: string,
  resolvedPubkey: string | null,
  decodedAddress: ReturnType<typeof decodeNostrAddress> | null,
  limit: number
): Promise<{ filtered: NostrEvent[]; allRepos: NostrEvent[] }> {
  const filters: NostrFilter[] = [];
  
  // Build normal filters based on query type
  if (resolvedPubkey) {
    // Search by owner pubkey
    filters.push({
      kinds: [KIND.REPO_ANNOUNCEMENT],
      authors: [resolvedPubkey],
      limit: limit * 2
    });
  }
  
  if (decodedAddress?.type === 'naddr') {
    // Search by naddr (repo address)
    const naddrPubkey = decodedAddress.pubkey;
    const naddrIdentifier = decodedAddress.identifier;
    if (naddrPubkey && naddrIdentifier) {
      filters.push({
        kinds: [KIND.REPO_ANNOUNCEMENT],
        authors: [naddrPubkey],
        '#d': [naddrIdentifier],
        limit: limit * 2
      });
    }
  }
  
  if (decodedAddress?.type === 'note' || decodedAddress?.type === 'nevent') {
    // Search by event ID
    const eventId = decodedAddress.id;
    if (eventId) {
      filters.push({
        kinds: [KIND.REPO_ANNOUNCEMENT],
        ids: [eventId],
        limit: 1
      });
    }
  }
  
  // Check if it's a hex event ID
  if (/^[a-f0-9]{64}$/i.test(queryTrimmed)) {
    filters.push({
      kinds: [KIND.REPO_ANNOUNCEMENT],
      ids: [queryTrimmed.toLowerCase()],
      limit: 1
    });
  }
  
  // Check if query looks like a d-tag (repo name)
  if (/^[a-zA-Z0-9_-]+$/.test(queryTrimmed)) {
    filters.push({
      kinds: [KIND.REPO_ANNOUNCEMENT],
      '#d': [queryTrimmed],
      limit: limit * 2
    });
  }
  
  // Always fetch all repos for text-based filtering (if not a specific identifier)
  const isSpecificIdentifier = resolvedPubkey !== null || decodedAddress !== null || /^[a-f0-9]{64}$/i.test(queryTrimmed);
  if (!isSpecificIdentifier) {
    // Fetch all repos for client-side filtering
    filters.push({
      kinds: [KIND.REPO_ANNOUNCEMENT],
      limit: 1000
    });
  }
  
  // Add NIP-50 search filter (for text queries)
  if (!isSpecificIdentifier) {
    filters.push({
      kinds: [KIND.REPO_ANNOUNCEMENT],
      search: queryTrimmed,
      limit: limit * 2
    });
  }
  
  // Fetch from all filters in parallel (with error handling)
  logger.debug({ filterCount: filters.length, query: queryTrimmed.substring(0, 50) }, 'Fetching from relays with filters');
  const fetchPromises = filters.map((filter, index) => 
    nostrClient.fetchEvents([filter])
      .catch(err => {
        logger.debug({ error: err, filterIndex: index, filter }, 'Failed to fetch events for filter');
        return [] as NostrEvent[]; // Return empty array on error
      })
  );
  const resultsArrays = await Promise.allSettled(fetchPromises);
  
  // Merge and deduplicate using deduplication keys (all repos fetched)
  // For replaceable/parameterized replaceable events, use kind:pubkey:d-tag as key
  const allReposMap = new Map<string, NostrEvent>();
  for (const result of resultsArrays) {
    if (result.status === 'fulfilled') {
      const results = result.value;
      for (const event of results) {
        const key = getDeduplicationKey(event);
        const existing = allReposMap.get(key);
        if (!existing || event.created_at > existing.created_at) {
          allReposMap.set(key, event);
        }
      }
    } else {
      logger.debug({ error: result.reason }, 'Filter fetch rejected');
    }
  }
  
  const allRepos = Array.from(allReposMap.values());
  
  // Filter results based on query (for text-based searches)
  let filteredResults = allRepos;
  
  if (!isSpecificIdentifier) {
    // Apply client-side filtering for text queries
    filteredResults = filterRepos(allRepos, queryTrimmed, queryLower, resolvedPubkey, decodedAddress);
  }
  
  return { filtered: filteredResults, allRepos };
}

/**
 * Filter repos based on query
 */
function filterRepos(
  repos: NostrEvent[],
  queryTrimmed: string,
  queryLower: string,
  resolvedPubkey: string | null,
  decodedAddress: ReturnType<typeof decodeNostrAddress> | null
): NostrEvent[] {
  return repos.filter(event => {
    // Extract repo fields
    const repoId = event.tags.find(t => t[0] === 'd')?.[1] || '';
    const name = event.tags.find(t => t[0] === 'name')?.[1] || '';
    const title = event.tags.find(t => t[0] === 'title')?.[1] || '';
    const description = event.tags.find(t => t[0] === 'description')?.[1] || '';
    const summary = event.tags.find(t => t[0] === 'summary')?.[1] || '';
    const content = event.content || '';
    
    // Check if query matches event ID (hex or note1)
    if (decodedAddress?.type === 'note' || decodedAddress?.type === 'nevent') {
      const eventId = decodedAddress.id;
      if (eventId && event.id.toLowerCase() === eventId.toLowerCase()) {
        return true;
      }
    }
    
    // Check if query matches hex event ID
    if (/^[a-f0-9]{64}$/i.test(queryTrimmed) && event.id.toLowerCase() === queryTrimmed.toLowerCase()) {
      return true;
    }
    
    // Check if query matches naddr (repo address)
    if (decodedAddress?.type === 'naddr') {
      const naddrPubkey = decodedAddress.pubkey;
      const naddrIdentifier = decodedAddress.identifier;
      if (naddrPubkey && naddrIdentifier &&
          event.pubkey.toLowerCase() === naddrPubkey.toLowerCase() && 
          repoId.toLowerCase() === naddrIdentifier.toLowerCase()) {
        return true;
      }
    }
    
    // Check if query matches owner pubkey
    if (resolvedPubkey && event.pubkey.toLowerCase() === resolvedPubkey.toLowerCase()) {
      return true;
    }
    
    // Check if query matches maintainer
    if (resolvedPubkey) {
      for (const tag of event.tags) {
        if (tag[0] === 'maintainers') {
          for (let i = 1; i < tag.length; i++) {
            const maintainer = tag[i];
            if (!maintainer || typeof maintainer !== 'string') continue;
            
            let maintainerPubkey = maintainer;
            try {
              const decoded = nip19.decode(maintainer);
              if (decoded.type === 'npub') {
                maintainerPubkey = decoded.data as string;
              }
            } catch {
              // Assume hex
            }
            
            if (maintainerPubkey.toLowerCase() === resolvedPubkey.toLowerCase()) {
              return true;
            }
          }
        }
      }
    }
    
    // Check d-tag (repo ID) - exact match first, then partial
    if (repoId) {
      if (repoId.toLowerCase() === queryLower) {
        return true; // Exact d-tag match
      }
      if (repoId.toLowerCase().includes(queryLower)) {
        return true; // Partial d-tag match
      }
    }
    
    // Check text fields: name, title, description, summary, content
    if (name.toLowerCase().includes(queryLower) ||
        title.toLowerCase().includes(queryLower) ||
        description.toLowerCase().includes(queryLower) ||
        summary.toLowerCase().includes(queryLower) ||
        content.toLowerCase().includes(queryLower)) {
      return true;
    }
    
    // Check t-tags (topics) - exact match first, then partial
    for (const tag of event.tags) {
      if (tag[0] === 't' && tag[1]) {
        const topic = tag[1].toLowerCase();
        if (topic === queryLower) {
          return true; // Exact t-tag match
        }
        if (topic.includes(queryLower)) {
          return true; // Partial t-tag match
        }
      }
    }
    
    // Check other common tags
    // Check 'r' tags (references, including earliest unique commit)
    for (const tag of event.tags) {
      if (tag[0] === 'r' && tag[1] && tag[1].toLowerCase().includes(queryLower)) {
        return true;
      }
    }
    
    // Check 'web' tags (website URLs)
    for (const tag of event.tags) {
      if (tag[0] === 'web' && tag[1] && tag[1].toLowerCase().includes(queryLower)) {
        return true;
      }
    }
    
    // Check clone URLs
    for (const tag of event.tags) {
      if (tag[0] === 'clone') {
        for (let i = 1; i < tag.length; i++) {
          const cloneUrl = tag[i];
          if (cloneUrl && typeof cloneUrl === 'string' && cloneUrl.toLowerCase().includes(queryLower)) {
            return true;
          }
        }
      }
    }
    
    return false;
  });
}

/**
 * Handle code search (type=code)
 */
async function handleCodeSearch(
  event: { url: URL; request: Request },
  query: string,
  limit: number,
  repoFilter: string | null,
  requestContext: ReturnType<typeof extractRequestContext>
) {
  const repoRoot = typeof process !== 'undefined' && process.env?.GIT_REPO_ROOT
    ? process.env.GIT_REPO_ROOT
    : '/repos';

  interface CodeSearchResult {
    repo: string;
    npub: string;
    file: string;
    line: number;
    content: string;
    branch: string;
  }

  const results: CodeSearchResult[] = [];

  try {
    // If repo filter is specified, search only that repo
    if (repoFilter) {
      const [npub, repo] = repoFilter.split('/');
      if (npub && repo) {
        const repoPath = join(repoRoot, npub, `${repo}.git`);
        if (existsSync(repoPath)) {
          const repoResults = await searchInRepoForCode(npub, repo, query, limit);
          results.push(...repoResults);
        }
      }
      return json(results);
    }

    // Search across all repositories
    // First, get list of all repos from filesystem
    if (!existsSync(repoRoot)) {
      return json([]);
    }

    const users = await readdir(repoRoot);
    
    for (const user of users) {
      const userPath = join(repoRoot, user);
      const userStat = await stat(userPath);
      
      if (!userStat.isDirectory()) {
        continue;
      }

      const repos = await readdir(userPath);
      
      for (const repo of repos) {
        if (!repo.endsWith('.git')) {
          continue;
        }

        const repoName = repo.replace(/\.git$/, '');
        const repoPath = join(userPath, repo);
        const repoStat = await stat(repoPath);
        
        if (!repoStat.isDirectory()) {
          continue;
        }

        // Check access for private repos
        try {
          const maintainerService = new MaintainerService(DEFAULT_NOSTR_RELAYS);
          
          // Decode npub to hex
          let repoOwnerPubkey: string;
          try {
            const decoded = nip19.decode(user);
            if (decoded.type === 'npub') {
              repoOwnerPubkey = decoded.data as string;
            } else {
              repoOwnerPubkey = user; // Assume it's already hex
            }
          } catch {
            repoOwnerPubkey = user; // Assume it's already hex
          }

          const canView = await maintainerService.canView(
            requestContext.userPubkeyHex || null,
            repoOwnerPubkey,
            repoName
          );

          if (!canView) {
            continue; // Skip private repos user can't access
          }
        } catch (accessErr) {
          logger.debug({ error: accessErr, user, repo: repoName }, 'Error checking access, skipping repo');
          continue;
        }

        // Search in this repo
        try {
          const repoResults = await searchInRepoForCode(user, repoName, query, limit - results.length);
          results.push(...repoResults);
          
          if (results.length >= limit) {
            break;
          }
        } catch (searchErr) {
          logger.debug({ error: searchErr, user, repo: repoName }, 'Error searching repo, continuing');
          continue;
        }
      }

      if (results.length >= limit) {
        break;
      }
    }

    return json(results.slice(0, limit));
  } catch (err) {
    logger.error({ error: err, query }, 'Error performing code search');
    throw handleApiError(err, { operation: 'codeSearch' }, 'Failed to perform code search');
  }
}

async function searchInRepoForCode(
  npub: string,
  repo: string,
  query: string,
  limit: number
): Promise<Array<{ repo: string; npub: string; file: string; line: number; content: string; branch: string }>> {
  const repoRoot = typeof process !== 'undefined' && process.env?.GIT_REPO_ROOT
    ? process.env.GIT_REPO_ROOT
    : '/repos';
  const repoPath = join(repoRoot, npub, `${repo}.git`);
  
  if (!existsSync(repoPath)) {
    return [];
  }

  const results: Array<{ repo: string; npub: string; file: string; line: number; content: string; branch: string }> = [];
  const git = simpleGit(repoPath);
  
  try {
    // Get default branch
    let branch = 'HEAD';
    try {
      const branches = await git.branchLocal();
      branch = branches.current || 'HEAD';
      // If no current branch, try common defaults
      if (!branch || branch === 'HEAD') {
        const allBranches = branches.all.map(b => b.replace(/^remotes\/origin\//, '').replace(/^remotes\//, ''));
        branch = allBranches.find(b => b === 'main') || allBranches.find(b => b === 'master') || allBranches[0] || 'main';
      }
    } catch {
      branch = 'main';
    }

    // For bare repositories, we need to use a worktree or search the index
    let worktreePath: string | null = null;
    try {
      // Get the actual branch name (resolve HEAD if needed)
      let actualBranch = branch;
      if (branch === 'HEAD') {
        actualBranch = 'main';
      }

      // Get or create worktree
      worktreePath = await fileManager.getWorktree(repoPath, actualBranch, npub, repo);
    } catch (worktreeError) {
      logger.debug({ error: worktreeError, npub, repo, branch }, 'Could not create worktree, trying git grep with tree reference');
      // Fall back to searching the index
    }

    const searchQuery = query.trim();
    
    // If we have a worktree, search in the worktree
    if (worktreePath && existsSync(worktreePath)) {
      try {
        const worktreeGit = simpleGit(worktreePath);
        const gitArgs = ['grep', '-n', '-I', '--break', '--heading', searchQuery];
        const grepOutput = await worktreeGit.raw(gitArgs);
        
        if (!grepOutput || !grepOutput.trim()) {
          return [];
        }

        // Parse git grep output
        const lines = grepOutput.split('\n');
        let currentFile = '';
        
        for (const line of lines) {
          if (!line.trim()) {
            continue;
          }
          
          // Check if this is a filename (no colon)
          if (!line.includes(':')) {
            currentFile = line.trim();
            continue;
          }
          
          // Parse line:content format
          const colonIndex = line.indexOf(':');
          if (colonIndex > 0 && currentFile) {
            const lineNumber = parseInt(line.substring(0, colonIndex), 10);
            const content = line.substring(colonIndex + 1);
            
            if (!isNaN(lineNumber) && content) {
              // Make file path relative to repo root
              const relativeFile = currentFile.replace(worktreePath + '/', '').replace(/^\.\//, '');
              results.push({
                repo,
                npub,
                file: relativeFile,
                line: lineNumber,
                content: content.trim(),
                branch: branch === 'HEAD' ? 'HEAD' : branch
              });
              
              if (results.length >= limit) {
                break;
              }
            }
          }
        }
      } catch (grepError: any) {
        // git grep returns exit code 1 when no matches found
        if (grepError.message && grepError.message.includes('exit code 1')) {
          return [];
        }
        throw grepError;
      }
    } else {
      // Fallback: search in the index using git grep with tree reference
      try {
        // Get the tree for the branch
        let treeRef = branch;
        if (branch === 'HEAD') {
          try {
            const branchInfo = await git.branch(['-a']);
            treeRef = branchInfo.current || 'HEAD';
          } catch {
            treeRef = 'HEAD';
          }
        }

        // Use git grep with tree reference for bare repos
        const gitArgs = ['grep', '-n', '-I', '--break', '--heading', searchQuery, treeRef];
        const grepOutput = await git.raw(gitArgs);
        
        if (!grepOutput || !grepOutput.trim()) {
          return [];
        }

        // Parse git grep output
        const lines = grepOutput.split('\n');
        let currentFile = '';
        
        for (const line of lines) {
          if (!line.trim()) {
            continue;
          }
          
          // Check if this is a filename (no colon)
          if (!line.includes(':')) {
            currentFile = line.trim();
            continue;
          }
          
          // Parse line:content format
          const colonIndex = line.indexOf(':');
          if (colonIndex > 0 && currentFile) {
            const lineNumber = parseInt(line.substring(0, colonIndex), 10);
            const content = line.substring(colonIndex + 1);
            
            if (!isNaN(lineNumber) && content) {
              results.push({
                repo,
                npub,
                file: currentFile,
                line: lineNumber,
                content: content.trim(),
                branch: branch === 'HEAD' ? 'HEAD' : branch
              });
              
              if (results.length >= limit) {
                break;
              }
            }
          }
        }
      } catch (grepError: any) {
        // git grep returns exit code 1 when no matches found
        if (grepError.message && grepError.message.includes('exit code 1')) {
          return [];
        }
        throw grepError;
      }
    }
  } catch (err) {
    logger.debug({ error: err, npub, repo, query }, 'Error searching in repo');
    return [];
  }

  return results;
}
