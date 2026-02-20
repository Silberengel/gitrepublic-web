/**
 * API endpoint for validating repository announcements
 * Checks if repo has valid announcement in nostr/repo-events.jsonl and on relays
 */

import { json, error, type RequestHandler } from '@sveltejs/kit';
import { createRepoGetHandler } from '$lib/utils/api-handlers.js';
import type { RepoRequestContext } from '$lib/utils/api-context.js';
import { fileManager, nostrClient } from '$lib/services/service-registry.js';
import { validateAnnouncementEvent } from '$lib/services/nostr/repo-verification.js';
import { KIND } from '$lib/types/nostr.js';
import { requireNpubHex } from '$lib/utils/npub-utils.js';
import type { NostrEvent } from '$lib/types/nostr.js';
import logger from '$lib/services/logger.js';

/**
 * GET - Validate repository announcement
 * Checks:
 * - Announcement exists in repo (nostr/repo-events.jsonl)
 * - Announcement exists on relays
 * - Announcement signature is valid
 * - Announcement matches repo (d-tag matches repo name)
 */
export const GET: RequestHandler = createRepoGetHandler(
  async (context: RepoRequestContext) => {
    const { npub, repo } = context;
    const repoOwnerPubkey = requireNpubHex(npub);
    
    // Check if repo exists
    if (!fileManager.repoExists(npub, repo)) {
      return json({
        valid: false,
        error: 'Repository not found',
        inRepo: false,
        onRelays: false
      });
    }
    
    let inRepo = false;
    let onRelays = false;
    let repoAnnouncement: NostrEvent | null = null;
    let relayAnnouncement: NostrEvent | null = null;
    let validationError: string | undefined;
    
    // Check announcement in repo (nostr/repo-events.jsonl)
    try {
      const repoEventsFile = await fileManager.getFileContent(npub, repo, 'nostr/repo-events.jsonl', 'HEAD');
      const lines = repoEventsFile.content.trim().split('\n').filter(Boolean);
      let latestTimestamp = 0;
      
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'announcement' && entry.event && entry.timestamp) {
            if (entry.timestamp > latestTimestamp) {
              latestTimestamp = entry.timestamp;
              repoAnnouncement = entry.event;
            }
          }
        } catch {
          continue;
        }
      }
      
      if (repoAnnouncement) {
        inRepo = true;
      }
    } catch (err) {
      logger.debug({ error: err, npub, repo }, 'Failed to read announcement from repo');
    }
    
    // Check announcement on relays
    try {
      const events = await nostrClient.fetchEvents([
        {
          kinds: [KIND.REPO_ANNOUNCEMENT],
          authors: [repoOwnerPubkey],
          '#d': [repo],
          limit: 1
        }
      ]);
      
      if (events.length > 0) {
        relayAnnouncement = events[0];
        onRelays = true;
      }
    } catch (err) {
      logger.debug({ error: err, npub, repo }, 'Failed to fetch announcement from relays');
    }
    
    // Use repo announcement if available, otherwise use relay announcement
    const announcement = repoAnnouncement || relayAnnouncement;
    
    if (!announcement) {
      return json({
        valid: false,
        error: 'No announcement found in repo or on relays',
        inRepo: false,
        onRelays: false
      });
    }
    
    // Validate the announcement
    const validation = validateAnnouncementEvent(announcement, repo);
    if (!validation.valid) {
      validationError = validation.error;
    }
    
    // Check if announcements match (if both exist)
    let announcementsMatch = true;
    if (repoAnnouncement && relayAnnouncement) {
      announcementsMatch = repoAnnouncement.id === relayAnnouncement.id;
    }
    
    return json({
      valid: validation.valid && announcementsMatch,
      error: validationError || (announcementsMatch ? undefined : 'Announcements in repo and on relays do not match'),
      inRepo,
      onRelays,
      announcementsMatch: repoAnnouncement && relayAnnouncement ? announcementsMatch : undefined,
      announcementId: announcement.id,
      announcementPubkey: announcement.pubkey,
      announcementCreatedAt: announcement.created_at,
      repoAnnouncementId: repoAnnouncement?.id,
      relayAnnouncementId: relayAnnouncement?.id
    });
  },
  { operation: 'validateRepo', requireRepoAccess: false } // Validation is public
);
