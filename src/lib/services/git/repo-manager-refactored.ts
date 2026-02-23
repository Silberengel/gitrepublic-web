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
import { shouldUseTor, getTorProxy } from '../../utils/tor.js';

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
   */
  async provisionRepo(event: NostrEvent, selfTransferEvent?: NostrEvent, isExistingRepo: boolean = false): Promise<void> {
    const cloneUrls = this.urlParser.extractCloneUrls(event);
    const domainUrl = cloneUrls.find(url => url.includes(this.domain));
    
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
      
      // Ensure announcement event is saved to nostr/repo-events.jsonl in the repository
      await this.announcementManager.ensureAnnouncementInRepo(repoPath.fullPath, event, selfTransferEvent);
      
      // If there are other clone URLs, sync from them after creating the repo
      if (otherUrls.length > 0) {
        const remoteUrls = this.urlParser.prepareRemoteUrls(otherUrls);
        await this.remoteSync.syncFromRemotes(repoPath.fullPath, remoteUrls);
      } else {
        // No external URLs - this is a brand new repo, create initial branch and README
        await this.createInitialBranchAndReadme(repoPath.fullPath, repoPath.npub, repoPath.repoName, event);
      }
    } else {
      // For existing repos, check if announcement exists in repo
      // If not, try to fetch from relays and save it
      const hasAnnouncement = await this.announcementManager.hasAnnouncementInRepoFile(repoPath.fullPath);
      if (!hasAnnouncement) {
        // Try to fetch from relays
        const fetchedEvent = await this.announcementManager.fetchAnnouncementFromRelays(event.pubkey, repoPath.repoName);
        if (fetchedEvent) {
          // Save fetched announcement to repo
          await this.announcementManager.ensureAnnouncementInRepo(repoPath.fullPath, fetchedEvent, selfTransferEvent);
        } else {
          // Announcement not found in repo or relays - this is a problem
          logger.warn({ repoPath: repoPath.fullPath }, 'Existing repo has no announcement in repo or on relays');
        }
      }
      
      if (selfTransferEvent) {
        // Ensure self-transfer event is also saved
        await this.announcementManager.ensureAnnouncementInRepo(repoPath.fullPath, event, selfTransferEvent);
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
    announcementEvent: NostrEvent
  ): Promise<void> {
    try {
      // Get default branch from environment or use 'master'
      const defaultBranch = process.env.DEFAULT_BRANCH || 'master';
      
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
      
      // For a new repo with no branches, we need to create an orphan branch first
      // Check if repo has any branches
      const git = simpleGit(repoPath);
      let hasBranches = false;
      try {
        const branches = await git.branch(['-a']);
        hasBranches = branches.all.length > 0;
      } catch {
        // No branches exist
        hasBranches = false;
      }
      
      if (!hasBranches) {
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
    announcementEvent?: NostrEvent
  ): Promise<{ success: boolean; needsAnnouncement?: boolean; announcement?: NostrEvent; error?: string; cloneUrls?: string[]; remoteUrls?: string[] }> {
    const repoPath = join(this.repoRoot, npub, `${repoName}.git`);
    
    // If repo already exists, check if it has an announcement
    if (existsSync(repoPath)) {
      const hasAnnouncement = await this.announcementManager.hasAnnouncementInRepoFile(repoPath);
      if (hasAnnouncement) {
        return { success: true };
      }
      
      // Repo exists but no announcement - try to fetch from relays
      const { requireNpubHex: requireNpubHexUtil } = await import('../../utils/npub-utils.js');
      const repoOwnerPubkey = requireNpubHexUtil(npub);
      const fetchedAnnouncement = await this.announcementManager.fetchAnnouncementFromRelays(repoOwnerPubkey, repoName);
      if (fetchedAnnouncement) {
        // Save fetched announcement to repo
        await this.announcementManager.ensureAnnouncementInRepo(repoPath, fetchedAnnouncement);
        return { success: true, announcement: fetchedAnnouncement };
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
      // Prepare remote URLs (filters out localhost/our domain, converts SSH to HTTPS)
      remoteUrls = this.urlParser.prepareRemoteUrls(cloneUrls);

      if (remoteUrls.length === 0) {
        logger.warn({ npub, repoName, cloneUrls, announcementEventId: announcementEvent.id }, 'No remote clone URLs found for on-demand fetch');
        return { success: false, needsAnnouncement: false };
      }
      
      logger.debug({ npub, repoName, cloneUrls, remoteUrls, isPublic }, 'On-demand fetch details');

      // Check if repoRoot exists and is writable
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

      // Get git environment for URL (handles Tor proxy, etc.)
      const gitEnv = this.getGitEnvForUrl(remoteUrls[0]);
      
      // Inject authentication token if available
      const authenticatedUrl = this.injectAuthToken(remoteUrls[0]);
      
      // Log if we're using authentication (but don't log the token)
      const isAuthenticated = authenticatedUrl !== remoteUrls[0];
      logger.info({ 
        npub, 
        repoName, 
        sourceUrl: remoteUrls[0], 
        cloneUrls,
        authenticated: isAuthenticated
      }, 'Fetching repository on-demand from remote');
      
      // Clone as bare repository
      await new Promise<void>((resolve, reject) => {
        const cloneProcess = spawn('git', ['clone', '--bare', authenticatedUrl, repoPath], {
          env: gitEnv,
          stdio: ['ignore', 'pipe', 'pipe']
        });

        let stderr = '';
        let stdout = '';
        cloneProcess.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        cloneProcess.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
        });

        cloneProcess.on('close', (code) => {
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
      try {
        await this.announcementManager.ensureAnnouncementInRepo(repoPath, announcementEvent);
      } catch (verifyError) {
        // Announcement file creation is optional - log but don't fail
        logger.warn({ error: verifyError, npub, repoName }, 'Failed to ensure announcement in repo, but repository is usable');
      }

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

  /**
   * Get git environment variables with Tor proxy if needed for .onion addresses
   * Security: Only whitelist necessary environment variables
   */
  private getGitEnvForUrl(url: string): Record<string, string> {
    // Whitelist only necessary environment variables for security
    const env: Record<string, string> = {
      PATH: process.env.PATH || '/usr/bin:/bin',
      HOME: process.env.HOME || '/tmp',
      USER: process.env.USER || 'git',
      LANG: process.env.LANG || 'C.UTF-8',
      LC_ALL: process.env.LC_ALL || 'C.UTF-8',
    };
    
    // Add TZ if set (for consistent timestamps)
    if (process.env.TZ) {
      env.TZ = process.env.TZ;
    }
    
    if (shouldUseTor(url)) {
      const proxy = getTorProxy();
      if (proxy) {
        // Git uses GIT_PROXY_COMMAND for proxy support
        const proxyCommand = `sh -c 'exec socat - SOCKS5:${proxy.host}:${proxy.port}:\\$1:\\$2' || sh -c 'exec nc -X 5 -x ${proxy.host}:${proxy.port} \\$1 \\$2'`;
        env.GIT_PROXY_COMMAND = proxyCommand;
        env.ALL_PROXY = `socks5://${proxy.host}:${proxy.port}`;
        
        // For HTTP/HTTPS URLs, also set http_proxy and https_proxy
        try {
          const urlObj = new URL(url);
          if (urlObj.protocol === 'http:' || urlObj.protocol === 'https:') {
            env.http_proxy = `socks5://${proxy.host}:${proxy.port}`;
            env.https_proxy = `socks5://${proxy.host}:${proxy.port}`;
          }
        } catch {
          // URL parsing failed, skip proxy env vars
        }
      }
    }
    
    return env;
  }

  /**
   * Inject authentication token into a git URL if needed
   * Supports GitHub tokens via GITHUB_TOKEN environment variable
   * Returns the original URL if no token is needed or available
   */
  private injectAuthToken(url: string): string {
    try {
      const urlObj = new URL(url);
      
      // If URL already has credentials, don't modify it
      if (urlObj.username) {
        return url;
      }
      
      // Check for GitHub token
      if (urlObj.hostname === 'github.com' || urlObj.hostname.endsWith('.github.com')) {
        const githubToken = process.env.GITHUB_TOKEN;
        if (githubToken) {
          // Inject token into URL: https://token@github.com/user/repo.git
          urlObj.username = githubToken;
          urlObj.password = ''; // GitHub uses token as username, password is empty
          return urlObj.toString();
        }
      }
      
      // Add support for other git hosting services here if needed
      // e.g., GitLab: GITLAB_TOKEN, Gitea: GITEA_TOKEN, etc.
      
      return url;
    } catch {
      // URL parsing failed, return original URL
      return url;
    }
  }
}
