/**
 * Announcement Manager
 * Handles saving and retrieving repository announcements from repos
 */

import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { mkdir, writeFile, rm } from 'fs/promises';
import simpleGit, { type SimpleGit } from 'simple-git';
import logger from '../logger.js';
import type { NostrEvent } from '../../types/nostr.js';
import { validateAnnouncementEvent } from '../nostr/repo-verification.js';
import { DEFAULT_NOSTR_RELAYS } from '../../config.js';
import { NostrClient } from '../nostr/nostr-client.js';
import { KIND } from '../../types/nostr.js';
import { RepoUrlParser } from './repo-url-parser.js';

/**
 * Announcement Manager
 * Handles saving and retrieving repository announcements from repos
 */
export class AnnouncementManager {
  private urlParser: RepoUrlParser;

  constructor(repoRoot: string = '/repos', domain: string = 'localhost:6543') {
    this.urlParser = new RepoUrlParser(repoRoot, domain);
  }

  /**
   * Check if an announcement event already exists in nostr/repo-events.jsonl
   */
  async hasAnnouncementInRepo(worktreePath: string, eventId?: string): Promise<boolean> {
    try {
      const jsonlFile = join(worktreePath, 'nostr', 'repo-events.jsonl');
      if (!existsSync(jsonlFile)) {
        return false;
      }
      
      const content = await readFile(jsonlFile, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'announcement' && entry.event) {
            // If eventId provided, check for exact match
            if (eventId) {
              if (entry.event.id === eventId) {
                return true;
              }
            } else {
              // Just check if any announcement exists
              return true;
            }
          }
        } catch {
          // Skip invalid lines
          continue;
        }
      }
      
      return false;
    } catch (err) {
      logger.debug({ error: err, worktreePath }, 'Failed to check for announcement in repo');
      return false;
    }
  }

  /**
   * Read announcement event from nostr/repo-events.jsonl
   */
  async getAnnouncementFromRepo(worktreePath: string): Promise<NostrEvent | null> {
    try {
      const jsonlFile = join(worktreePath, 'nostr', 'repo-events.jsonl');
      if (!existsSync(jsonlFile)) {
        return null;
      }
      
      const content = await readFile(jsonlFile, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      
      // Find the most recent announcement event
      let latestAnnouncement: NostrEvent | null = null;
      let latestTimestamp = 0;
      
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'announcement' && entry.event && entry.timestamp) {
            if (entry.timestamp > latestTimestamp) {
              latestTimestamp = entry.timestamp;
              latestAnnouncement = entry.event;
            }
          }
        } catch {
          // Skip invalid lines
          continue;
        }
      }
      
      return latestAnnouncement;
    } catch (err) {
      logger.debug({ error: err, worktreePath }, 'Failed to read announcement from repo');
      return null;
    }
  }

  /**
   * Fetch announcement from relays and validate it
   */
  async fetchAnnouncementFromRelays(
    repoOwnerPubkey: string,
    repoName: string
  ): Promise<NostrEvent | null> {
    try {
      const nostrClient = new NostrClient(DEFAULT_NOSTR_RELAYS);
      const events = await nostrClient.fetchEvents([
        {
          kinds: [KIND.REPO_ANNOUNCEMENT],
          authors: [repoOwnerPubkey],
          '#d': [repoName],
          limit: 1
        }
      ]);
      
      if (events.length === 0) {
        return null;
      }
      
      const event = events[0];
      
      // Validate the event
      const validation = validateAnnouncementEvent(event, repoName);
      if (!validation.valid) {
        logger.warn({ error: validation.error, repoName }, 'Fetched announcement failed validation');
        return null;
      }
      
      return event;
    } catch (err) {
      logger.debug({ error: err, repoOwnerPubkey, repoName }, 'Failed to fetch announcement from relays');
      return null;
    }
  }

  /**
   * Save a repo event (announcement or transfer) to nostr/repo-events.jsonl
   * Only saves if not already present (for announcements)
   * This provides a standard location for all repo-related Nostr events for easy analysis
   */
  async saveRepoEventToWorktree(
    worktreePath: string,
    event: NostrEvent,
    eventType: 'announcement' | 'transfer',
    skipIfExists: boolean = true
  ): Promise<boolean> {
    try {
      // For announcements, check if already exists
      if (eventType === 'announcement' && skipIfExists) {
        const exists = await this.hasAnnouncementInRepo(worktreePath, event.id);
        if (exists) {
          logger.debug({ eventId: event.id, worktreePath }, 'Announcement already exists in repo, skipping');
          return false;
        }
      }
      
      // Create nostr directory in worktree
      const nostrDir = join(worktreePath, 'nostr');
      await mkdir(nostrDir, { recursive: true });
      
      // Append to repo-events.jsonl with event type metadata
      const jsonlFile = join(nostrDir, 'repo-events.jsonl');
      const eventLine = JSON.stringify({
        type: eventType,
        timestamp: event.created_at,
        event
      }) + '\n';
      await writeFile(jsonlFile, eventLine, { flag: 'a', encoding: 'utf-8' });
      return true;
    } catch (err) {
      logger.debug({ error: err, worktreePath, eventType }, 'Failed to save repo event to nostr/repo-events.jsonl');
      // Don't throw - this is a nice-to-have feature
      return false;
    }
  }

  /**
   * Ensure announcement event is saved to nostr/repo-events.jsonl in the repository
   * Only saves if not already present (avoids redundant entries)
   */
  async ensureAnnouncementInRepo(repoPath: string, event: NostrEvent, selfTransferEvent?: NostrEvent): Promise<void> {
    try {
      // Create a temporary working directory
      const repoName = this.urlParser.parseRepoPathForName(repoPath)?.repoName || 'temp';
      const workDir = join(repoPath, '..', `${repoName}.work`);
      
      // Clean up if exists
      if (existsSync(workDir)) {
        await rm(workDir, { recursive: true, force: true });
      }
      await mkdir(workDir, { recursive: true });

      // Clone the bare repo
      const git: SimpleGit = simpleGit();
      await git.clone(repoPath, workDir);

      // Check if announcement already exists in nostr/repo-events.jsonl
      const hasAnnouncement = await this.hasAnnouncementInRepo(workDir, event.id);
      
      const filesToAdd: string[] = [];
      
      // Only save announcement if not already present
      if (!hasAnnouncement) {
        const saved = await this.saveRepoEventToWorktree(workDir, event, 'announcement', false);
        if (saved) {
          filesToAdd.push('nostr/repo-events.jsonl');
          logger.info({ repoPath, eventId: event.id }, 'Saved announcement to nostr/repo-events.jsonl');
        }
      } else {
        logger.debug({ repoPath, eventId: event.id }, 'Announcement already exists in repo, skipping');
      }
      
      // Save transfer event if provided
      if (selfTransferEvent) {
        const saved = await this.saveRepoEventToWorktree(workDir, selfTransferEvent, 'transfer', false);
        if (saved) {
          if (!filesToAdd.includes('nostr/repo-events.jsonl')) {
            filesToAdd.push('nostr/repo-events.jsonl');
          }
        }
      }

      // Only commit if we added files
      if (filesToAdd.length > 0) {
        const workGit: SimpleGit = simpleGit(workDir);
        await workGit.add(filesToAdd);
        
        // Use the event timestamp for commit date
        const commitDate = new Date(event.created_at * 1000).toISOString();
        const commitMessage = selfTransferEvent 
          ? 'Add Nostr repository announcement and initial ownership proof'
          : 'Add Nostr repository announcement';
        
        // Note: Initial commits are unsigned. The repository owner can sign their own commits
        // when they make changes. The server should never sign commits on behalf of users.
        
        await workGit.commit(commitMessage, filesToAdd, {
          '--author': `Nostr <${event.pubkey}@nostr>`,
          '--date': commitDate
        });

        // Push back to bare repo
        // Use default branch from environment or try 'main' first, then 'master'
        const defaultBranch = process.env.DEFAULT_BRANCH || 'main';
        await workGit.push(['origin', defaultBranch]).catch(async () => {
          // If default branch doesn't exist, try to create it
          try {
            await workGit.checkout(['-b', defaultBranch]);
            await workGit.push(['origin', defaultBranch]);
          } catch {
            // If default branch creation fails, try 'main' or 'master' as fallback
            const fallbackBranch = defaultBranch === 'main' ? 'master' : 'main';
            try {
              await workGit.checkout(['-b', fallbackBranch]);
              await workGit.push(['origin', fallbackBranch]);
            } catch {
              // If all fails, log but don't throw - announcement is saved
              logger.warn({ repoPath, defaultBranch, fallbackBranch }, 'Failed to push announcement to any branch');
            }
          }
        });
      }

      // Clean up
      await rm(workDir, { recursive: true, force: true });
    } catch (error) {
      logger.error({ error, repoPath }, 'Failed to ensure announcement in repo');
      // Don't throw - announcement file creation is important but shouldn't block provisioning
    }
  }

  /**
   * Check if a repository already has an announcement in nostr/repo-events.jsonl
   * Used to determine if this is a truly new repo or an existing one being added
   */
  async hasAnnouncementInRepoFile(repoPath: string): Promise<boolean> {
    if (!existsSync(repoPath)) {
      return false;
    }

    try {
      const git: SimpleGit = simpleGit();
      const repoName = this.urlParser.parseRepoPathForName(repoPath)?.repoName || 'temp';
      const workDir = join(repoPath, '..', `${repoName}.check`);
      
      // Clean up if exists
      if (existsSync(workDir)) {
        await rm(workDir, { recursive: true, force: true });
      }
      await mkdir(workDir, { recursive: true });

      // Try to clone and check for announcement in nostr/repo-events.jsonl
      await git.clone(repoPath, workDir);
      const hasAnnouncement = await this.hasAnnouncementInRepo(workDir, undefined);

      // Clean up
      await rm(workDir, { recursive: true, force: true });
      
      return hasAnnouncement;
    } catch {
      // If we can't check, assume it doesn't have one
      return false;
    }
  }
}
