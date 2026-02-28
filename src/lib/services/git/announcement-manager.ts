/**
 * Announcement Manager
 * Handles saving and retrieving repository announcements from repos
 */

import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { mkdir, writeFile, rm, readdir } from 'fs/promises';
import { copyFileSync, mkdirSync, existsSync as fsExistsSync } from 'fs';
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
  async ensureAnnouncementInRepo(repoPath: string, event: NostrEvent, selfTransferEvent?: NostrEvent, preferredDefaultBranch?: string): Promise<void> {
    let isEmpty = false;
    try {
      // Create a temporary working directory
      const repoName = this.urlParser.parseRepoPathForName(repoPath)?.repoName || 'temp';
      const workDir = join(repoPath, '..', `${repoName}.work`);
      
      // Clean up if exists
      if (existsSync(workDir)) {
        await rm(workDir, { recursive: true, force: true });
      }
      await mkdir(workDir, { recursive: true });

      // Check if repo has any commits (is empty)
      const bareGit: SimpleGit = simpleGit(repoPath);
      try {
        const logResult = await bareGit.log(['--all', '-1']);
        isEmpty = logResult.total === 0;
      } catch {
        // If log fails, assume repo is empty
        isEmpty = true;
      }

      const git: SimpleGit = simpleGit();
      let workGit: SimpleGit;
      
      if (isEmpty) {
        // Repo is empty - initialize worktree and create initial branch
        // Use preferred branch, then environment, then try 'main' first, then 'master'
        const defaultBranch = preferredDefaultBranch || process.env.DEFAULT_BRANCH || 'main';
        
        // Initialize git in workdir
        workGit = simpleGit(workDir);
        await workGit.init(false);
        await workGit.raw(['-C', workDir, 'checkout', '-b', defaultBranch]);
        
        // Add the bare repo as remote
        await workGit.addRemote('origin', repoPath);
      } else {
        // Repo has commits - clone normally
        await git.clone(repoPath, workDir);
        // Create workGit instance after clone
        workGit = simpleGit(workDir);
        
        // Determine the correct default branch to commit to
        let targetBranch = preferredDefaultBranch || process.env.DEFAULT_BRANCH || 'main';
        
        // Check if the preferred branch exists, if not try to find the actual default branch
        try {
          const branches = await workGit.branch(['-a']);
          const branchList = branches.all
            .map(b => b.replace(/^remotes\/origin\//, '').replace(/^remotes\//, '').replace(/^refs\/heads\//, ''))
            .filter(b => b && !b.includes('HEAD'));
          
          // If preferred branch exists, use it; otherwise try main/master, then first branch
          if (preferredDefaultBranch && branchList.includes(preferredDefaultBranch)) {
            targetBranch = preferredDefaultBranch;
          } else if (branchList.includes('main')) {
            targetBranch = 'main';
          } else if (branchList.includes('master')) {
            targetBranch = 'master';
          } else if (branchList.length > 0) {
            targetBranch = branchList[0];
          }
          
          // Checkout the target branch
          try {
            await workGit.checkout(targetBranch);
            logger.debug({ repoPath, targetBranch }, 'Checked out target branch for announcement commit');
          } catch (checkoutErr) {
            // If checkout fails, try to create the branch
            logger.debug({ repoPath, targetBranch, error: checkoutErr }, 'Failed to checkout branch, will try to create it');
            try {
              await workGit.checkout(['-b', targetBranch]);
              logger.debug({ repoPath, targetBranch }, 'Created and checked out new branch for announcement commit');
            } catch (createErr) {
              logger.warn({ repoPath, targetBranch, error: createErr }, 'Failed to create branch, will commit to current branch');
            }
          }
        } catch (branchErr) {
          logger.warn({ repoPath, error: branchErr }, 'Failed to determine or checkout branch, will commit to current branch');
        }
      }

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
        logger.info({ repoPath, filesToAdd, isEmpty }, 'Adding files and committing announcement');
        await workGit.add(filesToAdd);
        
        // Configure git user.name and user.email for this repository
        // This is required for git commits to work (committer identity)
        // We use a generic identity since the server is making the commit on behalf of the system
        try {
          await workGit.addConfig('user.name', 'GitRepublic', false, 'local');
          await workGit.addConfig('user.email', 'gitrepublic@gitrepublic.web', false, 'local');
          logger.debug({ repoPath }, 'Configured git user.name and user.email for repository');
        } catch (configError) {
          logger.warn({ repoPath, error: configError }, 'Failed to set git config, commit may fail');
        }
        
        // Use the event timestamp for commit date
        const commitDate = new Date(event.created_at * 1000).toISOString();
        const commitMessage = selfTransferEvent 
          ? 'Add Nostr repository announcement and initial ownership proof'
          : 'Add Nostr repository announcement';
        
        // Note: Initial commits are unsigned. The repository owner can sign their own commits
        // when they make changes. The server should never sign commits on behalf of users.
        
        logger.info({ repoPath, commitMessage, isEmpty }, 'Committing announcement file');
        await workGit.commit(commitMessage, filesToAdd, {
          '--author': `Nostr <${event.pubkey}@nostr>`,
          '--date': commitDate
        });
        
        // Verify commit was created
        const commitHash = await workGit.revparse(['HEAD']).catch(() => null);
        if (!commitHash) {
          throw new Error('Commit was created but HEAD is not pointing to a valid commit');
        }
        logger.info({ repoPath, commitHash, isEmpty, workDir }, 'Commit created successfully');
        
        // Verify objects were created
        const workObjectsDir = join(workDir, '.git', 'objects');
        if (!fsExistsSync(workObjectsDir)) {
          throw new Error(`Objects directory does not exist at ${workObjectsDir} after commit`);
        }
        const objectEntries = await readdir(workObjectsDir, { withFileTypes: true });
        const hasObjects = objectEntries.some(entry => {
          if (entry.isDirectory()) return true; // Loose objects in subdirectories
          if (entry.isFile() && entry.name.endsWith('.pack')) return true; // Pack files
          return false;
        });
        if (!hasObjects) {
          throw new Error(`No objects found in ${workObjectsDir} after commit - commit may have failed`);
        }
        logger.info({ repoPath, commitHash, objectCount: objectEntries.length }, 'Objects verified after commit');

        // Push back to bare repo
        // Use preferred branch, then environment, then try 'main' first, then 'master'
        const defaultBranch = preferredDefaultBranch || process.env.DEFAULT_BRANCH || 'main';
        
        if (isEmpty) {
          // For empty repos, directly copy objects and update refs (more reliable than push)
          try {
            logger.info({ repoPath, workDir, commitHash, defaultBranch }, 'Starting object copy for empty repo');
            
            // Copy all objects from workdir to bare repo
            const workObjectsDir = join(workDir, '.git', 'objects');
            const bareObjectsDir = join(repoPath, 'objects');
            
            logger.info({ workObjectsDir, bareObjectsDir, exists: fsExistsSync(workObjectsDir) }, 'Checking objects directory');
            
            // Ensure bare objects directory exists
            await mkdir(bareObjectsDir, { recursive: true });
            
            // Copy object files (pack files and loose objects)
            if (fsExistsSync(workObjectsDir)) {
              const objectEntries = await readdir(workObjectsDir, { withFileTypes: true });
              logger.info({ objectEntryCount: objectEntries.length }, 'Found object entries to copy');
              
              for (const entry of objectEntries) {
                const sourcePath = join(workObjectsDir, entry.name);
                const targetPath = join(bareObjectsDir, entry.name);
                
                if (entry.isDirectory()) {
                  // Copy subdirectory (for loose objects: XX/YYYY...)
                  await mkdir(targetPath, { recursive: true });
                  const subEntries = await readdir(sourcePath, { withFileTypes: true });
                  logger.debug({ subdir: entry.name, subEntryCount: subEntries.length }, 'Copying object subdirectory');
                  for (const subEntry of subEntries) {
                    const subSource = join(sourcePath, subEntry.name);
                    const subTarget = join(targetPath, subEntry.name);
                    if (subEntry.isFile()) {
                      copyFileSync(subSource, subTarget);
                    }
                  }
                } else if (entry.isFile()) {
                  // Copy file (pack files, etc.)
                  logger.debug({ file: entry.name }, 'Copying object file');
                  copyFileSync(sourcePath, targetPath);
                }
              }
              logger.info({ repoPath }, 'Finished copying objects');
            } else {
              logger.warn({ workObjectsDir }, 'Workdir objects directory does not exist');
            }
            
            // Update the ref in bare repo
            const refPath = join(repoPath, 'refs', 'heads', defaultBranch);
            const refDir = dirname(refPath);
            await mkdir(refDir, { recursive: true });
            await writeFile(refPath, `${commitHash}\n`);
            logger.info({ refPath, commitHash }, 'Updated branch ref');
            
            // Update HEAD in bare repo to point to the new branch
            await bareGit.raw(['symbolic-ref', 'HEAD', `refs/heads/${defaultBranch}`]);
            logger.info({ repoPath, defaultBranch, commitHash }, 'Successfully copied objects and updated refs in bare repo');
          } catch (copyError) {
            // If copy fails, try fallback branch
            const fallbackBranch = defaultBranch === 'main' ? 'master' : 'main';
            try {
              // Rename current branch to fallback
              await workGit.raw(['-C', workDir, 'branch', '-m', fallbackBranch]);
              
              // Get the commit hash
              const commitHash = await workGit.revparse(['HEAD']);
              
              // Copy objects (same as above)
              const workObjectsDir = join(workDir, '.git', 'objects');
              const bareObjectsDir = join(repoPath, 'objects');
              await mkdir(bareObjectsDir, { recursive: true });
              
              if (fsExistsSync(workObjectsDir)) {
                const objectEntries = await readdir(workObjectsDir, { withFileTypes: true });
                for (const entry of objectEntries) {
                  const sourcePath = join(workObjectsDir, entry.name);
                  const targetPath = join(bareObjectsDir, entry.name);
                  
                  if (entry.isDirectory()) {
                    await mkdir(targetPath, { recursive: true });
                    const subEntries = await readdir(sourcePath, { withFileTypes: true });
                    for (const subEntry of subEntries) {
                      const subSource = join(sourcePath, subEntry.name);
                      const subTarget = join(targetPath, subEntry.name);
                      if (subEntry.isFile()) {
                        copyFileSync(subSource, subTarget);
                      }
                    }
                  } else if (entry.isFile()) {
                    copyFileSync(sourcePath, targetPath);
                  }
                }
              }
              
              // Update ref
              const refPath = join(repoPath, 'refs', 'heads', fallbackBranch);
              const refDir = dirname(refPath);
              await mkdir(refDir, { recursive: true });
              await writeFile(refPath, `${commitHash}\n`);
              
              // Update HEAD
              await bareGit.raw(['symbolic-ref', 'HEAD', `refs/heads/${fallbackBranch}`]);
              
              logger.info({ repoPath, fallbackBranch, commitHash }, 'Successfully copied objects and updated refs with fallback branch');
            } catch (fallbackError) {
              logger.error({ repoPath, defaultBranch, fallbackBranch, copyError, fallbackError }, 'Failed to copy objects and update refs');
              throw fallbackError; // Re-throw to be caught by outer try-catch
            }
          }
        } else {
          // For non-empty repos, push normally
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
      }

      // Clean up
      await rm(workDir, { recursive: true, force: true });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      logger.error({ 
        error: errorMessage, 
        errorStack,
        repoPath,
        eventId: event.id,
        isEmpty
      }, 'Failed to ensure announcement in repo');
      
      // Don't throw - this is now non-blocking
      // The announcement is available from relays, so this is just for offline papertrail
      // Even for empty repos, we don't throw since provisioning should succeed regardless
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
