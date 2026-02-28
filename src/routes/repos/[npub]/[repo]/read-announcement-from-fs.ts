/**
 * Server-only utility to read repository announcements from filesystem
 * This file should only be imported server-side via dynamic import
 * 
 * Note: This file uses Node.js-only modules and must not be statically imported on the client
 */

import { join, resolve } from 'path';
import { existsSync } from 'fs';
import { simpleGit } from 'simple-git';
import logger from '$lib/services/logger.js';
import type { NostrEvent } from '$lib/types/nostr.js';

// Resolve GIT_REPO_ROOT to absolute path (handles both relative and absolute paths)
const repoRootEnv = typeof process !== 'undefined' && process.env?.GIT_REPO_ROOT
  ? process.env.GIT_REPO_ROOT
  : '/repos';
const repoRoot = resolve(repoRootEnv);

/**
 * Read announcement from filesystem (nostr/repo-events.jsonl)
 * Returns null if not found or on error
 * Server-side only - do not call on client
 */
export async function readAnnouncementFromFilesystem(npub: string, repoName: string, expectedPubkey: string): Promise<NostrEvent | null> {
  // Guard against client-side execution
  if (typeof process === 'undefined' || typeof process.env === 'undefined') {
    return null;
  }
  
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
    
    // Validate the announcement (case-insensitive repo name matching)
    const { validateAnnouncementEvent } = await import('$lib/services/nostr/repo-verification.js');
    const dTag = announcementEvent.tags.find(t => t[0] === 'd')?.[1];
    
    // Check if d-tag matches repo name (case-insensitive)
    if (!dTag || dTag.toLowerCase() !== repoName.toLowerCase()) {
      logger.debug({ npub, repoName, dTag }, 'Announcement d-tag does not match repo name (case-insensitive)');
      return null;
    }
    
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
