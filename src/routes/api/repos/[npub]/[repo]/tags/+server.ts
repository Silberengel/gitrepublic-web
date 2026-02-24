/**
 * API endpoint for getting and creating tags
 */

import { json } from '@sveltejs/kit';
// @ts-ignore - SvelteKit generates this type
import type { RequestHandler } from './$types';
import { fileManager, nostrClient } from '$lib/services/service-registry.js';
import { createRepoGetHandler, createRepoPostHandler } from '$lib/utils/api-handlers.js';
import type { RepoRequestContext, RequestEvent } from '$lib/utils/api-context.js';
import { handleValidationError, handleNotFoundError } from '$lib/utils/error-handler.js';
import { join } from 'path';
import { existsSync } from 'fs';
import { eventCache } from '$lib/services/nostr/event-cache.js';
import { fetchRepoAnnouncementsWithCache, findRepoAnnouncement } from '$lib/utils/nostr-utils.js';
import logger from '$lib/services/logger.js';

const repoRoot = typeof process !== 'undefined' && process.env?.GIT_REPO_ROOT
  ? process.env.GIT_REPO_ROOT
  : '/repos';

export const GET: RequestHandler = createRepoGetHandler(
  async (context: RepoRequestContext) => {
    const repoPath = join(repoRoot, context.npub, `${context.repo}.git`);
    
    // If repo doesn't exist locally, try API fallback
    if (!existsSync(repoPath)) {
      try {
        const allEvents = await fetchRepoAnnouncementsWithCache(nostrClient, context.repoOwnerPubkey, eventCache);
        const announcement = findRepoAnnouncement(allEvents, context.repo);
        
        if (announcement) {
          const { tryApiFetch } = await import('$lib/utils/api-repo-helper.js');
          const apiData = await tryApiFetch(announcement, context.npub, context.repo);
          
          if (apiData && apiData.tags && apiData.tags.length > 0) {
            logger.debug({ npub: context.npub, repo: context.repo, tagCount: apiData.tags.length }, 'Successfully fetched tags via API fallback');
            // Convert API tags to FileManager.Tag format
            const tags = apiData.tags.map(t => ({
              name: t.name,
              hash: t.sha,
              message: t.message,
              date: undefined // API fallback doesn't provide date
            }));
            return json(tags);
          }
        }
      } catch (apiErr) {
        logger.debug({ error: apiErr, npub: context.npub, repo: context.repo }, 'API fallback failed for tags');
      }
      
      // No tags found via API fallback, return empty array
      return json([]);
    }
    
    try {
      const tags = await fileManager.getTags(context.npub, context.repo);
      
      // If repo exists but has no tags (empty repo), try API fallback
      if (tags.length === 0) {
        logger.debug({ npub: context.npub, repo: context.repo }, 'Repo exists but is empty, attempting API fallback for tags');
        
        try {
          const allEvents = await fetchRepoAnnouncementsWithCache(nostrClient, context.repoOwnerPubkey, eventCache);
          const announcement = findRepoAnnouncement(allEvents, context.repo);
          
          if (announcement) {
            const { tryApiFetch } = await import('$lib/utils/api-repo-helper.js');
            const apiData = await tryApiFetch(announcement, context.npub, context.repo);
            
            if (apiData && apiData.tags && apiData.tags.length > 0) {
              logger.info({ npub: context.npub, repo: context.repo, tagCount: apiData.tags.length }, 'Successfully fetched tags via API fallback for empty repo');
              // Convert API tags to FileManager.Tag format
              const apiTags = apiData.tags.map(t => ({
                name: t.name,
                hash: t.sha,
                message: t.message
              }));
              return json(apiTags);
            }
          }
        } catch (apiErr) {
          logger.debug({ error: apiErr, npub: context.npub, repo: context.repo }, 'API fallback failed for empty repo, returning empty tags');
        }
      }
      
      return json(tags);
    } catch (err) {
      // If error occurs, try API fallback before giving up
      logger.debug({ error: err, npub: context.npub, repo: context.repo }, '[Tags] Error getting tags, attempting API fallback');
      
      try {
        const allEvents = await fetchRepoAnnouncementsWithCache(nostrClient, context.repoOwnerPubkey, eventCache);
        const announcement = findRepoAnnouncement(allEvents, context.repo);
        
        if (announcement) {
          const { tryApiFetch } = await import('$lib/utils/api-repo-helper.js');
          const apiData = await tryApiFetch(announcement, context.npub, context.repo);
          
          if (apiData && apiData.tags && apiData.tags.length > 0) {
            logger.info({ npub: context.npub, repo: context.repo, tagCount: apiData.tags.length }, 'Successfully fetched tags via API fallback after error');
            // Convert API tags to FileManager.Tag format
            const apiTags = apiData.tags.map(t => ({
              name: t.name,
              hash: t.sha,
              message: t.message
            }));
            return json(apiTags);
          }
        }
      } catch (apiErr) {
        logger.debug({ error: apiErr, npub: context.npub, repo: context.repo }, 'API fallback failed after error');
      }
      
      // If all else fails, return empty array
      logger.warn({ error: err, npub: context.npub, repo: context.repo }, '[Tags] Error getting tags, returning empty array');
      return json([]);
    }
  },
  { operation: 'getTags', requireRepoExists: false, requireRepoAccess: true } // Handle on-demand fetching, but check access for private repos
);

export const POST: RequestHandler = createRepoPostHandler(
  async (context: RepoRequestContext, event: RequestEvent) => {
    const body = await event.request.json();
    const { tagName, ref, message } = body;

    if (!tagName) {
      throw handleValidationError('Missing tagName parameter', { operation: 'createTag', npub: context.npub, repo: context.repo });
    }

    await fileManager.createTag(context.npub, context.repo, tagName, ref || 'HEAD', message);
    return json({ success: true, message: 'Tag created successfully' });
  },
  { operation: 'createTag' }
);
