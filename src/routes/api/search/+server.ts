/**
 * API endpoint for searching repositories and code
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { NostrClient } from '$lib/services/nostr/nostr-client.js';
import { MaintainerService } from '$lib/services/nostr/maintainer-service.js';
import { DEFAULT_NOSTR_RELAYS, DEFAULT_NOSTR_SEARCH_RELAYS } from '$lib/config.js';
import { KIND } from '$lib/types/nostr.js';
import { FileManager } from '$lib/services/git/file-manager.js';
import { nip19 } from 'nostr-tools';
import { existsSync } from 'fs';
import { join } from 'path';
import { handleApiError, handleValidationError } from '$lib/utils/error-handler.js';
import { extractRequestContext } from '$lib/utils/api-context.js';
import logger from '$lib/services/logger.js';

const repoRoot = process.env.GIT_REPO_ROOT || '/repos';
const fileManager = new FileManager(repoRoot);
const maintainerService = new MaintainerService(DEFAULT_NOSTR_RELAYS);

export const GET: RequestHandler = async (event) => {
  const query = event.url.searchParams.get('q');
  const type = event.url.searchParams.get('type') || 'repos'; // repos, code, or all
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
    // Use search relays which are more likely to support NIP-50
    const nostrClient = new NostrClient(DEFAULT_NOSTR_SEARCH_RELAYS);
    
    const results: {
      repos: Array<{ id: string; name: string; description: string; owner: string; npub: string }>;
      code: Array<{ repo: string; npub: string; file: string; matches: number }>;
    } = {
      repos: [],
      code: []
    };

    // Search repositories using NIP-50
    if (type === 'repos' || type === 'all') {
      let events: Array<{ id: string; pubkey: string; tags: string[][]; content: string; created_at: number }> = [];
      
      try {
        // Try NIP-50 search first (relays that support it will return results sorted by relevance)
        events = await nostrClient.fetchEvents([
          {
            kinds: [KIND.REPO_ANNOUNCEMENT],
            search: query, // NIP-50: Search field
            limit: limit * 2 // Get more results to account for different relay implementations
          }
        ]);
        
        // NIP-50 search succeeded
      } catch (nip50Error) {
        // Fallback to manual filtering if NIP-50 fails or isn't supported
        
        const allEvents = await nostrClient.fetchEvents([
          {
            kinds: [KIND.REPO_ANNOUNCEMENT],
            limit: 500 // Get more events for manual filtering
          }
        ]);
        
        const searchLower = query.toLowerCase();
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
      
      // Process events into results with privacy filtering
      const searchLower = query.toLowerCase();
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
        } else if (userPubkey) {
          // Private repos require authentication - check if user owns, maintains, or has bookmarked
          try {
            // Check if user is owner or maintainer
            canView = await maintainerService.canView(userPubkey, event.pubkey, repoId);
            
            // If not owner/maintainer, check if user has bookmarked it
            if (!canView) {
              const { BookmarksService } = await import('$lib/services/nostr/bookmarks-service.js');
              const bookmarksService = new BookmarksService(DEFAULT_NOSTR_SEARCH_RELAYS);
              const repoAddress = `${KIND.REPO_ANNOUNCEMENT}:${event.pubkey}:${repoId}`;
              canView = await bookmarksService.isBookmarked(userPubkey, repoAddress);
            }
          } catch (err) {
            logger.warn({ error: err, pubkey: event.pubkey, repo: repoId }, 'Failed to check repo access in search');
            canView = false;
          }
        }
        
        // Only include repos the user can view
        if (!canView) continue;
        
        const name = event.tags.find(t => t[0] === 'name')?.[1] || '';
        const description = event.tags.find(t => t[0] === 'description')?.[1] || '';

        try {
          const npub = nip19.npubEncode(event.pubkey);
          results.repos.push({
            id: event.id,
            name: name || repoId,
            description: description || '',
            owner: event.pubkey,
            npub
          });
        } catch {
          // Skip if npub encoding fails
        }
      }

      // Sort by relevance (name matches first, then description)
      // Note: NIP-50 compliant relays should already return results sorted by relevance
      results.repos.sort((a, b) => {
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
    }

    // Search code (basic file content search)
    if (type === 'code' || type === 'all') {
      // Get all repos on this server
      const allRepos: Array<{ npub: string; repo: string }> = [];
      
      // This is a simplified search - in production, you'd want to index files
      // For now, we'll search through known repos
      try {
        const repoDirs = await import('fs/promises').then(fs => 
          fs.readdir(repoRoot, { withFileTypes: true })
        );

        for (const dir of repoDirs) {
          if (dir.isDirectory()) {
            const npub = dir.name;
            try {
              const repoFiles = await import('fs/promises').then(fs =>
                fs.readdir(join(repoRoot, npub), { withFileTypes: true })
              );

              for (const repoFile of repoFiles) {
                if (repoFile.isDirectory() && repoFile.name.endsWith('.git')) {
                  const repo = repoFile.name.replace('.git', '');
                  allRepos.push({ npub, repo });
                }
              }
            } catch {
              // Skip if can't read directory
            }
          }
        }
      } catch {
        // If we can't list repos, skip code search
      }

      // Filter repos by privacy before searching code
      const accessibleRepos: Array<{ npub: string; repo: string }> = [];
      for (const { npub, repo } of allRepos.slice(0, 10)) { // Limit to 10 repos for performance
        try {
          // Decode npub to get pubkey
          const decoded = nip19.decode(npub);
          if (decoded.type !== 'npub') continue;
          const repoOwnerPubkey = decoded.data as string;
          
          // Check if user can view this repo
          const canView = await maintainerService.canView(userPubkey, repoOwnerPubkey, repo);
          if (canView) {
            accessibleRepos.push({ npub, repo });
          }
        } catch {
          // Skip if can't decode npub or check access
        }
      }

      // Search in files (limited to avoid performance issues)
      const searchLower = query.toLowerCase();
      let codeResults: Array<{ repo: string; npub: string; file: string; matches: number }> = [];

      for (const { npub, repo } of accessibleRepos) {
        try {
          const files = await fileManager.listFiles(npub, repo, 'HEAD', '');
          
          for (const file of files.slice(0, 50)) { // Limit to 50 files per repo
            if (file.type === 'file' && file.name.toLowerCase().includes(searchLower)) {
              codeResults.push({
                repo,
                npub,
                file: file.path,
                matches: 1
              });
            }
          }
        } catch {
          // Skip if can't access repo
        }
      }

      results.code = codeResults.slice(0, limit);
    }

    return json({
      query,
      type,
      results,
      total: results.repos.length + results.code.length
    });
  } catch (err) {
    return handleApiError(err, { operation: 'search', query, type }, 'Failed to search');
  }
};
