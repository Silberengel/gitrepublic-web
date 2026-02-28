/**
 * Repository manager for git repositories
 * Handles repo provisioning, syncing, and NIP-34 integration
 * 
 * Refactored to use focused service classes:
 * - RepoUrlParser: URL parsing and validation
 * - GitRemoteSync: Remote syncing (to/from)
 * - AnnouncementManager: Announcement handling in repos
 * - RepoSizeChecker: Size checking
 */

import { existsSync, mkdirSync, accessSync, constants } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import type { NostrEvent } from '../../types/nostr.js';
import { GIT_DOMAIN } from '../../config.js';
import { validateAnnouncementEvent } from '../nostr/repo-verification.js';
import simpleGit from 'simple-git';
import logger from '../logger.js';
import { sanitizeError } from '../../utils/security.js';
import { isPrivateRepo as checkIsPrivateRepo } from '../../utils/repo-privacy.js';
import { RepoUrlParser, type RepoPath } from './repo-url-parser.js';
import { GitRemoteSync } from './git-remote-sync.js';
import { AnnouncementManager } from './announcement-manager.js';
import { RepoSizeChecker } from './repo-size-checker.js';

/**
 * Check if a URL is a GRASP (Git Repository Access via Secure Protocol) URL
 * GRASP URLs contain npub (Nostr public key) in the path: https://host/npub.../repo.git
 */
export function isGraspUrl(url: string): boolean {
  // GRASP URLs have npub (starts with npub1) in the path
  return /\/npub1[a-z0-9]+/i.test(url);
}

export { type RepoPath };

/**
 * Repository Manager
 * Main facade for repository operations
 * Delegates to focused service classes for specific responsibilities
 */
export class RepoManager {
  private repoRoot: string;
  private domain: string;
  private urlParser: RepoUrlParser;
  private remoteSync: GitRemoteSync;
  private announcementManager: AnnouncementManager;
  private sizeChecker: RepoSizeChecker;

  constructor(repoRoot: string = '/repos', domain: string = GIT_DOMAIN) {
    this.repoRoot = repoRoot;
    this.domain = domain;
    this.urlParser = new RepoUrlParser(repoRoot, domain);
    this.remoteSync = new GitRemoteSync(repoRoot, domain);
    this.announcementManager = new AnnouncementManager(repoRoot, domain);
    this.sizeChecker = new RepoSizeChecker();
  }

  /**
   * Parse git domain URL to extract npub and repo name
   */
  parseRepoUrl(url: string): RepoPath | null {
    return this.urlParser.parseRepoUrl(url);
  }

  /**
   * Create a bare git repository from a NIP-34 repo announcement
   * 
   * @param event - The repo announcement event
   * @param selfTransferEvent - Optional self-transfer event to include in initial commit
   * @param isExistingRepo - Whether this is an existing repo being added to the server
   * @param allowMissingDomainUrl - In development, allow provisioning even if domain URL isn't in announcement
   * @param preferredDefaultBranch - Preferred default branch name (e.g., from user settings)
   */
  async provisionRepo(event: NostrEvent, selfTransferEvent?: NostrEvent, isExistingRepo: boolean = false, allowMissingDomainUrl: boolean = false, preferredDefaultBranch?: string): Promise<void> {
    const cloneUrls = this.urlParser.extractCloneUrls(event);
    let domainUrl = cloneUrls.find(url => url.includes(this.domain));
    
    // In development, if domain URL not found and allowed, construct it from the event
    if (!domainUrl && allowMissingDomainUrl) {
      const isLocalhost = this.domain.includes('localhost') || this.domain.includes('127.0.0.1');
      if (isLocalhost) {
        // Extract npub and repo name from event
        const dTag = event.tags.find(t => t[0] === 'd')?.[1];
        if (dTag) {
          const protocol = this.domain.startsWith('localhost') || this.domain.startsWith('127.0.0.1') ? 'http' : 'https';
          // Get npub from event pubkey
          const { nip19 } = await import('nostr-tools');
          const npub = nip19.npubEncode(event.pubkey);
          domainUrl = `${protocol}://${this.domain}/${npub}/${dTag}.git`;
          logger.info({ domain: this.domain, npub, repo: dTag, constructedUrl: domainUrl }, 'Constructed domain URL for development provisioning');
        }
      }
    }
    
    if (!domainUrl) {
      throw new Error(`No ${this.domain} URL found in repo announcement`);
    }

    const repoPath = this.urlParser.parseRepoUrl(domainUrl);
    if (!repoPath) {
      throw new Error(`Invalid ${this.domain} URL format`);
    }

    // Create directory structure
    const repoDir = join(this.repoRoot, repoPath.npub);
    if (!existsSync(repoDir)) {
      mkdirSync(repoDir, { recursive: true });
    }

    // Check if repo already exists
    const repoExists = existsSync(repoPath.fullPath);
    
    // Security: Only allow new repo creation if user has unlimited access
    // This prevents spam and abuse
    const isNewRepo = !repoExists;
    if (isNewRepo && !isExistingRepo) {
      const { getCachedUserLevel } = await import('../security/user-level-cache.js');
      const { hasUnlimitedAccess } = await import('../../utils/user-access.js');
      const userLevel = getCachedUserLevel(event.pubkey);
      if (!hasUnlimitedAccess(userLevel?.level)) {
        throw new Error(`Repository creation requires unlimited access. User has level: ${userLevel?.level || 'none'}`);
      }
    }
    
    // If there are other clone URLs, sync from them first (for existing repos)
    const otherUrls = cloneUrls.filter(url => !url.includes(this.domain));
    if (otherUrls.length > 0 && repoExists) {
      // For existing repos, sync first to get the latest state
      const remoteUrls = this.urlParser.prepareRemoteUrls(otherUrls);
      await this.remoteSync.syncFromRemotes(repoPath.fullPath, remoteUrls);
    }

    // Validate announcement event before proceeding
    const validation = validateAnnouncementEvent(event, repoPath.repoName);
    if (!validation.valid) {
      throw new Error(`Invalid announcement event: ${validation.error}`);
    }

    // Create bare repository if it doesn't exist
    if (isNewRepo) {
      // Use simple-git to create bare repo (safer than exec)
      const git = simpleGit();
      await git.init(['--bare', repoPath.fullPath]);
      
      // If there are other clone URLs, sync from them after creating the repo
      if (otherUrls.length > 0) {
        const remoteUrls = this.urlParser.prepareRemoteUrls(otherUrls);
        await this.remoteSync.syncFromRemotes(repoPath.fullPath, remoteUrls);
      }
      
      // Check if branches exist after sync (if any)
      const repoGit = simpleGit(repoPath.fullPath);
      let hasBranches = false;
      try {
        const branches = await repoGit.branch(['-a']);
        hasBranches = branches.all.length > 0;
      } catch {
        hasBranches = false;
      }
      
      if (!hasBranches) {
        // No branches exist - create initial branch and README (which includes announcement)
        await this.createInitialBranchAndReadme(repoPath.fullPath, repoPath.npub, repoPath.repoName, event, preferredDefaultBranch);
      } else {
        // Branches exist (from sync) - ensure README exists and announcement is committed to the default branch
        // Check if README exists, and create it if missing
        await this.ensureReadmeExists(repoPath.fullPath, repoPath.npub, repoPath.repoName, event, preferredDefaultBranch);
        
        // Ensure announcement is committed to the default branch
        // This must happen after syncing so we can commit it to the existing default branch
        // Make it blocking so the commit is complete before returning
        try {
          await this.announcementManager.ensureAnnouncementInRepo(repoPath.fullPath, event, selfTransferEvent, preferredDefaultBranch);
          logger.info({ repoPath: repoPath.fullPath, eventId: event.id }, 'Announcement committed to repository');
        } catch (err) {
          logger.warn({ error: err, repoPath: repoPath.fullPath, eventId: event.id }, 
            'Failed to save announcement to repo (announcement available from relays)');
        }
      }
    } else {
      // For existing repos, check if announcement exists in repo
      // If not, try to fetch from relays and save it
      // Note: We have the announcement from the clone request (event parameter), so we can use that
      const hasAnnouncement = await this.announcementManager.hasAnnouncementInRepoFile(repoPath.fullPath);
      if (!hasAnnouncement) {
        // We have the event from the clone request, so use it directly (no need to fetch from relays again)
        // Save announcement to repo asynchronously
        this.announcementManager.ensureAnnouncementInRepo(repoPath.fullPath, event, selfTransferEvent)
          .catch((err) => {
            logger.warn({ error: err, repoPath: repoPath.fullPath, eventId: event.id }, 
              'Failed to save announcement to repo (non-blocking, announcement available from relays)');
          });
      } else if (selfTransferEvent) {
        // Announcement exists but self-transfer might not - save it asynchronously
        this.announcementManager.ensureAnnouncementInRepo(repoPath.fullPath, event, selfTransferEvent)
          .catch((err) => {
            logger.warn({ error: err, repoPath: repoPath.fullPath, eventId: event.id }, 
              'Failed to save self-transfer to repo (non-blocking)');
          });
      }
    }
  }

  /**
   * Create initial branch and README.md for a new repository
   */
  private async createInitialBranchAndReadme(
    repoPath: string,
    npub: string,
    repoName: string,
    announcementEvent: NostrEvent,
    preferredDefaultBranch?: string
  ): Promise<void> {
    try {
      // Get default branch from preferred branch, git config, environment, or use 'master'
      // Check preferred branch first (from user settings), then git's init.defaultBranch config
      let defaultBranch = preferredDefaultBranch || process.env.DEFAULT_BRANCH || 'master';
      
      try {
        const git = simpleGit();
        // Try to get git's default branch setting
        const defaultBranchConfig = await git.raw(['config', '--get', 'init.defaultBranch']).catch(() => null);
        if (defaultBranchConfig && defaultBranchConfig.trim()) {
          defaultBranch = defaultBranchConfig.trim();
        }
      } catch {
        // If git config fails, use environment or fallback to 'master'
      }
      
      // Check if any branches already exist (e.g., from a remote sync)
      const repoGit = simpleGit(repoPath);
      let existingBranches: string[] = [];
      try {
        const branches = await repoGit.branch(['-a']);
        existingBranches = branches.all.map(b => b.replace(/^remotes\/origin\//, '').replace(/^remotes\//, '').replace(/^refs\/heads\//, ''));
        // Remove duplicates
        existingBranches = [...new Set(existingBranches)];
        
        // If branches exist, check if one matches our default branch preference
        if (existingBranches.length > 0) {
          // If we have a preferred branch and it exists, use it
          if (preferredDefaultBranch && existingBranches.includes(preferredDefaultBranch)) {
            defaultBranch = preferredDefaultBranch;
          } else {
            // Prefer existing branches that match common defaults, prioritizing preferred branch
            const preferredBranches = preferredDefaultBranch 
              ? [preferredDefaultBranch, defaultBranch, 'main', 'master', 'dev']
              : [defaultBranch, 'main', 'master', 'dev'];
            for (const preferred of preferredBranches) {
              if (existingBranches.includes(preferred)) {
                defaultBranch = preferred;
                break;
              }
            }
            // If no match, use the first existing branch
            if (!existingBranches.includes(defaultBranch)) {
              defaultBranch = existingBranches[0];
            }
          }
        }
      } catch {
        // No branches exist, use the determined default
      }
      
      // Get repo name from d-tag or use repoName from path
      const dTag = announcementEvent.tags.find(t => t[0] === 'd')?.[1] || repoName;
      
      // Get name tag for README title, fallback to d-tag
      const nameTag = announcementEvent.tags.find(t => t[0] === 'name')?.[1] || dTag;
      
      // Get author info from user profile (fetch from relays)
      const { fetchUserProfile, extractProfileData, getUserName, getUserEmail } = await import('../../utils/user-profile.js');
      const { nip19 } = await import('nostr-tools');
      const { DEFAULT_NOSTR_RELAYS } = await import('../../config.js');
      const userNpub = nip19.npubEncode(announcementEvent.pubkey);
      
      const profileEvent = await fetchUserProfile(announcementEvent.pubkey, DEFAULT_NOSTR_RELAYS);
      const profile = extractProfileData(profileEvent);
      const authorName = getUserName(profile, announcementEvent.pubkey, userNpub);
      const authorEmail = getUserEmail(profile, announcementEvent.pubkey, userNpub);
      
      // Create README.md content
      const readmeContent = `# ${nameTag}

Welcome to your new GitRepublic repo.

You can use this read-me file to explain the purpose of this repo to everyone who looks at it. You can also make a ReadMe.adoc file and delete this one, if you prefer. GitRepublic supports both markups.

Your commits will all be signed by your Nostr keys and saved to the event files in the ./nostr folder.
`;
      
      // Use FileManager to create the initial branch and files
      const { FileManager } = await import('./file-manager.js');
      const fileManager = new FileManager(this.repoRoot);
      
      // If no branches exist, create an orphan branch
      // We already checked for existing branches above, so if existingBranches is empty, create one
      if (existingBranches.length === 0) {
        // Create orphan branch first (pass undefined for fromBranch to create orphan)
        await fileManager.createBranch(npub, repoName, defaultBranch, undefined);
      }
      
      // Create both README.md and announcement in the initial commit
      // We'll use a worktree to write both files and commit them together
      const workDir = await fileManager.getWorktree(repoPath, defaultBranch, npub, repoName);
      const { writeFile: writeFileFs } = await import('fs/promises');
      const { join } = await import('path');
      
      // Write README.md
      const readmePath = join(workDir, 'README.md');
      await writeFileFs(readmePath, readmeContent, 'utf-8');
      
      // Save repo announcement event to nostr/repo-events.jsonl (only if not already present)
      const announcementSaved = await this.announcementManager.saveRepoEventToWorktree(workDir, announcementEvent, 'announcement', true);
      
      // Stage files
      const workGit = simpleGit(workDir);
      const filesToAdd: string[] = ['README.md'];
      if (announcementSaved) {
        filesToAdd.push('nostr/repo-events.jsonl');
      }
      await workGit.add(filesToAdd);
      
      // Configure git user.name and user.email for this repository
      // This is required for git commits to work (committer identity)
      // We use a generic identity since the server is making the commit on behalf of the system
      // The --author flag sets the author, but we still need committer identity configured
      try {
        await workGit.addConfig('user.name', 'GitRepublic', false, 'local');
        await workGit.addConfig('user.email', 'gitrepublic@gitrepublic.web', false, 'local');
        logger.debug({ repoPath, npub, repoName }, 'Configured git user.name and user.email for repository');
      } catch (configError) {
        logger.warn({ repoPath, npub, repoName, error: configError }, 'Failed to set git config, commit may fail');
      }
      
      // Commit files together
      await workGit.commit('Initial commit', filesToAdd, {
        '--author': `${authorName} <${authorEmail}>`
      });
      
      // Clean up worktree
      await fileManager.removeWorktree(repoPath, workDir);
      
      logger.info({ npub, repoName, branch: defaultBranch }, 'Created initial branch and README.md');
    } catch (err) {
      // Log but don't fail - initial README creation is nice-to-have
      const sanitizedErr = sanitizeError(err);
      logger.warn({ error: sanitizedErr, repoPath, npub, repoName }, 'Failed to create initial branch and README, continuing anyway');
    }
  }

  /**
   * Ensure README.md exists in the repository, creating it if missing
   * This is called when branches exist from sync but README might be missing
   */
  private async ensureReadmeExists(
    repoPath: string,
    npub: string,
    repoName: string,
    announcementEvent: NostrEvent,
    preferredDefaultBranch?: string
  ): Promise<void> {
    try {
      // Get default branch
      const { FileManager } = await import('./file-manager.js');
      const fileManager = new FileManager(this.repoRoot);
      let defaultBranch = preferredDefaultBranch;
      
      if (!defaultBranch) {
        try {
          defaultBranch = await fileManager.getDefaultBranch(npub, repoName);
        } catch {
          // If getDefaultBranch fails, try to determine from git
          const repoGit = simpleGit(repoPath);
          try {
            const branches = await repoGit.branch(['-a']);
            const branchList = branches.all
              .map(b => b.replace(/^remotes\/origin\//, '').replace(/^remotes\//, '').replace(/^refs\/heads\//, ''))
              .filter(b => b && !b.includes('HEAD'));
            if (branchList.length > 0) {
              // Prefer preferred branch, then main, then master, then first branch
              if (preferredDefaultBranch && branchList.includes(preferredDefaultBranch)) {
                defaultBranch = preferredDefaultBranch;
              } else if (branchList.includes('main')) {
                defaultBranch = 'main';
              } else if (branchList.includes('master')) {
                defaultBranch = 'master';
              } else {
                defaultBranch = branchList[0];
              }
            }
          } catch {
            defaultBranch = preferredDefaultBranch || process.env.DEFAULT_BRANCH || 'master';
          }
        }
      }

      if (!defaultBranch) {
        defaultBranch = preferredDefaultBranch || process.env.DEFAULT_BRANCH || 'master';
      }

      // Check if README.md already exists
      const workDir = await fileManager.getWorktree(repoPath, defaultBranch, npub, repoName);
      const { readFile: readFileFs, writeFile: writeFileFs } = await import('fs/promises');
      const { join } = await import('path');
      const readmePath = join(workDir, 'README.md');
      
      try {
        await readFileFs(readmePath, 'utf-8');
        // README exists, nothing to do
        await fileManager.removeWorktree(repoPath, workDir);
        logger.debug({ npub, repoName, branch: defaultBranch }, 'README.md already exists');
        return;
      } catch {
        // README doesn't exist, create it
      }

      // Get repo name from d-tag or use repoName from path
      const dTag = announcementEvent.tags.find(t => t[0] === 'd')?.[1] || repoName;
      
      // Get name tag for README title, fallback to d-tag
      const nameTag = announcementEvent.tags.find(t => t[0] === 'name')?.[1] || dTag;
      
      // Get author info from user profile (fetch from relays)
      const { fetchUserProfile, extractProfileData, getUserName, getUserEmail } = await import('../../utils/user-profile.js');
      const { nip19 } = await import('nostr-tools');
      const { DEFAULT_NOSTR_RELAYS } = await import('../../config.js');
      const userNpub = nip19.npubEncode(announcementEvent.pubkey);
      
      const profileEvent = await fetchUserProfile(announcementEvent.pubkey, DEFAULT_NOSTR_RELAYS);
      const profile = extractProfileData(profileEvent);
      const authorName = getUserName(profile, announcementEvent.pubkey, userNpub);
      const authorEmail = getUserEmail(profile, announcementEvent.pubkey, userNpub);
      
      // Create README.md content
      const readmeContent = `# ${nameTag}

Welcome to your new GitRepublic repo.

You can use this read-me file to explain the purpose of this repo to everyone who looks at it. You can also make a ReadMe.adoc file and delete this one, if you prefer. GitRepublic supports both markups.

Your commits will all be signed by your Nostr keys and saved to the event files in the ./nostr folder.
`;
      
      // Write README.md
      await writeFileFs(readmePath, readmeContent, 'utf-8');
      
      // Stage and commit README.md
      const workGit = simpleGit(workDir);
      await workGit.add('README.md');
      
      // Configure git user.name and user.email for this repository
      try {
        await workGit.addConfig('user.name', 'GitRepublic', false, 'local');
        await workGit.addConfig('user.email', 'gitrepublic@gitrepublic.web', false, 'local');
      } catch (configError) {
        logger.warn({ repoPath, npub, repoName, error: configError }, 'Failed to set git config');
      }
      
      // Commit README.md
      await workGit.commit('Add README.md', ['README.md'], {
        '--author': `${authorName} <${authorEmail}>`
      });
      
      // Clean up worktree
      await fileManager.removeWorktree(repoPath, workDir);
      
      logger.info({ npub, repoName, branch: defaultBranch }, 'Created README.md in existing repository');
    } catch (err) {
      // Log but don't fail - README creation is nice-to-have
      const sanitizedErr = sanitizeError(err);
      logger.warn({ error: sanitizedErr, repoPath, npub, repoName }, 'Failed to ensure README exists, continuing anyway');
    }
  }

  /**
   * Sync repository from multiple remote URLs (parallelized for efficiency)
   */
  async syncFromRemotes(repoPath: string, remoteUrls: string[]): Promise<void> {
    await this.remoteSync.syncFromRemotes(repoPath, remoteUrls);
  }

  /**
   * Sync repository to multiple remote URLs after a push (parallelized with retry)
   */
  async syncToRemotes(repoPath: string, remoteUrls: string[]): Promise<void> {
    await this.remoteSync.syncToRemotes(repoPath, remoteUrls);
  }

  /**
   * Check if a repository exists
   */
  repoExists(repoPath: string): boolean {
    return existsSync(repoPath);
  }

  /**
   * Fetch repository on-demand from remote clone URLs
   * This allows displaying repositories that haven't been provisioned yet
   * 
   * @param npub - Repository owner npub
   * @param repoName - Repository name
   * @param announcementEvent - The Nostr repo announcement event (optional, will fetch if not provided)
   * @returns true if repository was successfully fetched, false otherwise
   */
  async fetchRepoOnDemand(
    npub: string,
    repoName: string,
    announcementEvent?: NostrEvent,
    preferredDefaultBranch?: string
  ): Promise<{ success: boolean; needsAnnouncement?: boolean; announcement?: NostrEvent; error?: string; cloneUrls?: string[]; remoteUrls?: string[] }> {
    const repoPath = join(this.repoRoot, npub, `${repoName}.git`);
    
    // If repo already exists, check if it has an announcement
    if (existsSync(repoPath)) {
      const hasAnnouncement = await this.announcementManager.hasAnnouncementInRepoFile(repoPath);
      if (hasAnnouncement) {
        return { success: true };
      }
      
      // Repo exists but no announcement - use provided announcement or try to fetch from relays
      let announcementToUse: NostrEvent | null | undefined = announcementEvent;
      if (!announcementToUse) {
        const { requireNpubHex: requireNpubHexUtil } = await import('../../utils/npub-utils.js');
        const repoOwnerPubkey = requireNpubHexUtil(npub);
        announcementToUse = await this.announcementManager.fetchAnnouncementFromRelays(repoOwnerPubkey, repoName);
      }
      
      if (announcementToUse) {
        // Save announcement to repo asynchronously (non-blocking)
        // We have the announcement from relays, so this is just for offline papertrail
        this.announcementManager.ensureAnnouncementInRepo(repoPath, announcementToUse)
          .catch((err) => {
            logger.warn({ error: err, repoPath, eventId: announcementToUse?.id }, 
              'Failed to save announcement to repo (non-blocking, announcement available from relays)');
          });
        return { success: true, announcement: announcementToUse };
      }
      
      // Repo exists but no announcement found - needs announcement
      return { success: false, needsAnnouncement: true };
    }

    // If no announcement provided, try to fetch from relays
    if (!announcementEvent) {
      const { requireNpubHex: requireNpubHexUtil } = await import('../../utils/npub-utils.js');
      const repoOwnerPubkey = requireNpubHexUtil(npub);
      const fetchedAnnouncement = await this.announcementManager.fetchAnnouncementFromRelays(repoOwnerPubkey, repoName);
      if (fetchedAnnouncement) {
        announcementEvent = fetchedAnnouncement;
      } else {
        // No announcement found - needs announcement
        return { success: false, needsAnnouncement: true };
      }
    }

    // Check if repository is public
    const isPublic = !checkIsPrivateRepo(announcementEvent);

    // Security: For public repos, allow on-demand fetching regardless of owner's access level
    // For private repos, require owner to have unlimited access to prevent unauthorized creation
    if (!isPublic) {
      const { getCachedUserLevel } = await import('../security/user-level-cache.js');
      const { hasUnlimitedAccess } = await import('../../utils/user-access.js');
      const userLevel = getCachedUserLevel(announcementEvent.pubkey);
      if (!hasUnlimitedAccess(userLevel?.level)) {
        logger.warn({ 
          npub, 
          repoName,
          pubkey: announcementEvent.pubkey.slice(0, 16) + '...',
          level: userLevel?.level || 'none'
        }, 'Skipping on-demand repo fetch: private repo requires owner with unlimited access');
        return { success: false, needsAnnouncement: false };
      }
    } else {
      logger.info({ 
        npub, 
        repoName,
        pubkey: announcementEvent.pubkey.slice(0, 16) + '...'
      }, 'Allowing on-demand fetch for public repository');
    }

    // Extract clone URLs and prepare remote URLs
    const cloneUrls = this.urlParser.extractCloneUrls(announcementEvent);
    let remoteUrls: string[] = [];

    try {
      // Check if we're in development mode (localhost)
      const isLocalhost = this.domain.includes('localhost') || this.domain.includes('127.0.0.1');
      
      // If in development, prefer localhost URLs from GIT_DOMAIN
      if (isLocalhost) {
        // Construct localhost URL from GIT_DOMAIN
        const protocol = this.domain.startsWith('localhost') || this.domain.startsWith('127.0.0.1') ? 'http' : 'https';
        const localhostUrl = `${protocol}://${this.domain}/${npub}/${repoName}.git`;
        
        // Always use localhost URL in development, even if it's not in the clone URLs
        // This allows cloning from the local server during development
        remoteUrls = [localhostUrl];
        logger.info({ npub, repoName, url: localhostUrl, domain: this.domain }, 'Using localhost URL for development clone');
      } else {
        // Prepare remote URLs (filters out localhost/our domain, converts SSH to HTTPS)
        remoteUrls = this.urlParser.prepareRemoteUrls(cloneUrls);
      }

      // Check if repoRoot exists and is writable (needed for both provisioning and cloning)
      if (!existsSync(this.repoRoot)) {
        try {
          mkdirSync(this.repoRoot, { recursive: true });
          logger.info({ repoRoot: this.repoRoot }, 'Created repos root directory');
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          logger.error({ 
            repoRoot: this.repoRoot,
            error: error.message
          }, 'Failed to create repos root directory');
          throw new Error(`Cannot create repos root directory at ${this.repoRoot}. Please check permissions: ${error.message}`);
        }
      } else {
        // Check if repoRoot is writable
        try {
          accessSync(this.repoRoot, constants.W_OK);
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          logger.error({ 
            repoRoot: this.repoRoot,
            error: error.message
          }, 'Repos root directory is not writable');
          throw new Error(`Repos root directory at ${this.repoRoot} is not writable. Please fix permissions (e.g., chmod 755 ${this.repoRoot} or chown to the correct user).`);
        }
      }

      // Create directory structure
      const repoDir = join(this.repoRoot, npub);
      if (!existsSync(repoDir)) {
        try {
          mkdirSync(repoDir, { recursive: true });
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          if (error.message.includes('EACCES') || error.message.includes('permission denied')) {
            logger.error({ 
              npub, 
              repoName, 
              repoDir,
              repoRoot: this.repoRoot,
              error: error.message
            }, 'Permission denied when creating repository directory');
            throw new Error(`Permission denied: Cannot create repository directory at ${repoDir}. Please check that the server has write permissions to ${this.repoRoot}.`);
          }
          throw error;
        }
      }

      if (remoteUrls.length === 0) {
        // No remote URLs - this is an empty repo, provision it instead
        logger.info({ npub, repoName, cloneUrls, announcementEventId: announcementEvent.id }, 'No remote clone URLs found - provisioning empty repository');
        try {
          await this.provisionRepo(announcementEvent, undefined, false, false, preferredDefaultBranch);
          logger.info({ npub, repoName }, 'Empty repository provisioned successfully');
          return { success: true, cloneUrls, remoteUrls: [] };
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          logger.error({ npub, repoName, error: error.message }, 'Failed to provision empty repository');
          return { success: false, error: error.message, cloneUrls, remoteUrls: [] };
        }
      }
      
      logger.debug({ npub, repoName, cloneUrls, remoteUrls, isPublic }, 'On-demand fetch details');

      // In development mode, if using localhost URL, check if repo exists locally first
      // If it doesn't exist, provision it instead of trying to clone from non-existent URL
      if (isLocalhost && remoteUrls[0].includes(this.domain)) {
        const localRepoPath = join(this.repoRoot, npub, `${repoName}.git`);
        if (!existsSync(localRepoPath)) {
          // Repo doesn't exist on localhost - provision it instead
          logger.info({ npub, repoName, url: remoteUrls[0] }, 'Localhost URL specified but repo does not exist locally - provisioning instead');
          try {
            // In development, allow provisioning even if domain URL isn't in announcement
            await this.provisionRepo(announcementEvent, undefined, false, true, preferredDefaultBranch);
            logger.info({ npub, repoName }, 'Repository provisioned successfully on localhost');
            return { success: true, cloneUrls, remoteUrls: [] };
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            logger.error({ npub, repoName, error: error.message }, 'Failed to provision repository on localhost');
            return { success: false, error: error.message, cloneUrls, remoteUrls: [] };
          }
        }
      }

      // Get git environment for URL (handles Tor proxy, etc.)
      const gitEnv = this.remoteSync.getGitEnvForUrl(remoteUrls[0]);
      
      // Inject authentication token if available
      const authenticatedUrl = this.remoteSync.injectAuthToken(remoteUrls[0]);
      
      // Log if we're using authentication (but don't log the token)
      const isAuthenticated = authenticatedUrl !== remoteUrls[0];
      logger.info({ 
        npub, 
        repoName, 
        sourceUrl: remoteUrls[0], 
        cloneUrls,
        authenticated: isAuthenticated,
        isLocalhost
      }, 'Fetching repository on-demand from remote');
      
      // Clone as bare repository with timeout
      const { GIT_CLONE_TIMEOUT_MS } = await import('../../config.js');
      
      await new Promise<void>((resolve, reject) => {
        const cloneProcess = spawn('git', ['clone', '--bare', authenticatedUrl, repoPath], {
          env: gitEnv,
          stdio: ['ignore', 'pipe', 'pipe']
        });

        // Set timeout for clone operation
        const timeoutId = setTimeout(() => {
          cloneProcess.kill('SIGTERM');
          const forceKillTimeout = setTimeout(() => {
            if (!cloneProcess.killed) {
              cloneProcess.kill('SIGKILL');
            }
          }, 5000); // 5 second grace period
          
          cloneProcess.on('close', () => {
            clearTimeout(forceKillTimeout);
          });
          
          reject(new Error(`Git clone operation timed out after ${GIT_CLONE_TIMEOUT_MS}ms`));
        }, GIT_CLONE_TIMEOUT_MS);

        let stderr = '';
        let stdout = '';
        cloneProcess.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        cloneProcess.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
        });

        cloneProcess.on('close', (code) => {
          clearTimeout(timeoutId);
          if (code === 0) {
            logger.info({ npub, repoName, sourceUrl: remoteUrls[0] }, 'Successfully cloned repository');
            resolve();
          } else {
            const errorMsg = `Git clone failed with code ${code}: ${stderr || stdout}`;
            logger.error({ 
              npub, 
              repoName, 
              sourceUrl: remoteUrls[0], 
              code, 
              stderr, 
              stdout,
              authenticated: isAuthenticated
            }, 'Git clone failed');
            reject(new Error(errorMsg));
          }
        });

        cloneProcess.on('error', (err) => {
          clearTimeout(timeoutId);
          logger.error({ 
            npub, 
            repoName, 
            sourceUrl: remoteUrls[0], 
            error: err,
            authenticated: isAuthenticated
          }, 'Git clone process error');
          reject(err);
        });
      });

      // Verify the repository was actually created
      if (!existsSync(repoPath)) {
        throw new Error('Repository clone completed but repository path does not exist');
      }

      // Ensure announcement is saved to nostr/repo-events.jsonl (non-blocking - repo is usable without it)
      // Fire and forget - we have the announcement from relays, so this is just for offline papertrail
      this.announcementManager.ensureAnnouncementInRepo(repoPath, announcementEvent)
        .catch((verifyError) => {
          // Announcement file creation is optional - log but don't fail
          logger.warn({ error: verifyError, npub, repoName }, 'Failed to ensure announcement in repo, but repository is usable');
        });

      logger.info({ npub, repoName }, 'Successfully fetched repository on-demand');
      return { success: true, announcement: announcementEvent };
    } catch (error) {
      const sanitizedError = sanitizeError(error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ 
        error: sanitizedError, 
        npub, 
        repoName,
        cloneUrls,
        isPublic,
        remoteUrls,
        errorMessage
      }, 'Failed to fetch repository on-demand');
      return { 
        success: false, 
        needsAnnouncement: false,
        error: errorMessage,
        cloneUrls,
        remoteUrls
      };
    }
  }

  /**
   * Get repository size in bytes
   * Returns the total size of the repository directory
   */
  async getRepoSize(repoPath: string): Promise<number> {
    return this.sizeChecker.getRepoSize(repoPath);
  }

  /**
   * Check if repository size exceeds the maximum (2 GB)
   */
  async checkRepoSizeLimit(repoPath: string, maxSizeBytes: number = 2 * 1024 * 1024 * 1024): Promise<{ withinLimit: boolean; currentSize: number; maxSize: number; error?: string }> {
    return this.sizeChecker.checkRepoSizeLimit(repoPath, maxSizeBytes);
  }

}
