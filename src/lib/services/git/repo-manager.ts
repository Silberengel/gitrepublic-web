/**
 * Repository manager for git repositories
 * Handles repo provisioning, syncing, and NIP-34 integration
 */

import { existsSync, mkdirSync, writeFileSync, statSync, readFileSync } from 'fs';
import { join } from 'path';
import { readdir, readFile } from 'fs/promises';
import { spawn } from 'child_process';
import type { NostrEvent } from '../../types/nostr.js';
import { GIT_DOMAIN } from '../../config.js';
import { validateAnnouncementEvent } from '../nostr/repo-verification.js';
import simpleGit, { type SimpleGit } from 'simple-git';
import logger from '../logger.js';
import { shouldUseTor, getTorProxy } from '../../utils/tor.js';
import { sanitizeError } from '../../utils/security.js';

/**
 * Execute git command with custom environment variables safely
 * Uses spawn with argument arrays to prevent command injection
 * Security: Only uses whitelisted environment variables, does not spread process.env
 */
function execGitWithEnv(
  repoPath: string,
  args: string[],
  env: Record<string, string> = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const gitProcess = spawn('git', args, {
      cwd: repoPath,
      // Security: Only use whitelisted env vars, don't spread process.env
      // The env parameter should already contain only safe, whitelisted variables
      env: env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    gitProcess.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    gitProcess.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    gitProcess.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`Git command failed with code ${code}: ${stderr || stdout}`));
      }
    });

    gitProcess.on('error', (err) => {
      reject(err);
    });
  });
}

export interface RepoPath {
  npub: string;
  repoName: string;
  fullPath: string;
}

export class RepoManager {
  private repoRoot: string;
  private domain: string;

  constructor(repoRoot: string = '/repos', domain: string = GIT_DOMAIN) {
    this.repoRoot = repoRoot;
    this.domain = domain;
  }

  /**
   * Parse git domain URL to extract npub and repo name
   */
  parseRepoUrl(url: string): RepoPath | null {
    // Match: https://{domain}/{npub}/{repo-name}.git or http://{domain}/{npub}/{repo-name}.git
    // Escape domain for regex (replace dots with \.)
    const escapedDomain = this.domain.replace(/\./g, '\\.');
    const match = url.match(new RegExp(`${escapedDomain}\\/(npub[a-z0-9]+)\\/([^\\/]+)\\.git`));
    if (!match) return null;

    const [, npub, repoName] = match;
    const fullPath = join(this.repoRoot, npub, `${repoName}.git`);

    return { npub, repoName, fullPath };
  }

  /**
   * Create a bare git repository from a NIP-34 repo announcement
   * 
   * @param event - The repo announcement event
   * @param selfTransferEvent - Optional self-transfer event to include in initial commit
   * @param isExistingRepo - Whether this is an existing repo being added to the server
   */
  async provisionRepo(event: NostrEvent, selfTransferEvent?: NostrEvent, isExistingRepo: boolean = false): Promise<void> {
    const cloneUrls = this.extractCloneUrls(event);
    const domainUrl = cloneUrls.find(url => url.includes(this.domain));
    
    if (!domainUrl) {
      throw new Error(`No ${this.domain} URL found in repo announcement`);
    }

    const repoPath = this.parseRepoUrl(domainUrl);
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
      await this.syncFromRemotes(repoPath.fullPath, otherUrls);
    }

    // Validate announcement event before proceeding
    const { validateAnnouncementEvent } = await import('../nostr/repo-verification.js');
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
      await this.ensureAnnouncementInRepo(repoPath.fullPath, event, selfTransferEvent);
      
      // If there are other clone URLs, sync from them after creating the repo
      if (otherUrls.length > 0) {
        await this.syncFromRemotes(repoPath.fullPath, otherUrls);
      } else {
        // No external URLs - this is a brand new repo, create initial branch and README
        await this.createInitialBranchAndReadme(repoPath.fullPath, repoPath.npub, repoPath.repoName, event);
      }
    } else {
      // For existing repos, check if announcement exists in repo
      // If not, try to fetch from relays and save it
      const hasAnnouncement = await this.hasAnnouncementInRepoFile(repoPath.fullPath);
      if (!hasAnnouncement) {
        // Try to fetch from relays
        const fetchedEvent = await this.fetchAnnouncementFromRelays(event.pubkey, repoPath.repoName);
        if (fetchedEvent) {
          // Save fetched announcement to repo
          await this.ensureAnnouncementInRepo(repoPath.fullPath, fetchedEvent, selfTransferEvent);
        } else {
          // Announcement not found in repo or relays - this is a problem
          logger.warn({ repoPath: repoPath.fullPath }, 'Existing repo has no announcement in repo or on relays');
        }
      }
      
      if (selfTransferEvent) {
        // Ensure self-transfer event is also saved
        await this.ensureAnnouncementInRepo(repoPath.fullPath, event, selfTransferEvent);
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
      const announcementSaved = await this.saveRepoEventToWorktree(workDir, announcementEvent, 'announcement', true);
      
      // Stage files
      const workGit = simpleGit(workDir);
      const filesToAdd: string[] = ['README.md'];
      if (announcementSaved) {
        filesToAdd.push('nostr/repo-events.jsonl');
      }
      await workGit.add(filesToAdd);
      
      // Commit files together
      const commitResult = await workGit.commit('Initial commit', filesToAdd, {
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
   * Get git environment variables with Tor proxy if needed for .onion addresses
   * Security: Only whitelist necessary environment variables
   */
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
        // The command receives host and port as arguments
        // We'll create a simple proxy command using socat or nc
        // Note: This requires socat or netcat-openbsd to be installed
        const proxyCommand = `sh -c 'exec socat - SOCKS5:${proxy.host}:${proxy.port}:\\$1:\\$2' || sh -c 'exec nc -X 5 -x ${proxy.host}:${proxy.port} \\$1 \\$2'`;
        env.GIT_PROXY_COMMAND = proxyCommand;
        
        // Also set ALL_PROXY for git-remote-http
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
   * Sync from a single remote URL (helper for parallelization)
   */
  private async syncFromSingleRemote(repoPath: string, url: string, index: number): Promise<void> {
    const remoteName = `remote-${index}`;
    const git = simpleGit(repoPath);
    // Inject authentication token if available (e.g., GITHUB_TOKEN)
    const authenticatedUrl = this.injectAuthToken(url);
    const gitEnv = this.getGitEnvForUrl(authenticatedUrl);
    
    try {
      // Add remote if not exists (ignore error if already exists)
      // Use authenticated URL so git can access private repos
      try {
        await git.addRemote(remoteName, authenticatedUrl);
      } catch {
        // Remote might already exist, that's okay - try to update it
        try {
          await git.removeRemote(remoteName);
          await git.addRemote(remoteName, authenticatedUrl);
        } catch {
          // If update fails, continue - might be using old URL
        }
      }
      
      // Configure git proxy for this remote if it's a .onion address
      if (shouldUseTor(url)) {
        const proxy = getTorProxy();
        if (proxy) {
          try {
            // Use simple-git to set config (safer than exec)
            await git.addConfig(`http.${url}.proxy`, `socks5://${proxy.host}:${proxy.port}`, false, 'local');
          } catch {
            // Config might fail, continue anyway
          }
        }
      }
      
      // Fetch from remote with appropriate environment
      // Use spawn with proper argument arrays for security
      await execGitWithEnv(repoPath, ['fetch', remoteName, '--all'], gitEnv);
      
      // Update remote head
      try {
        await execGitWithEnv(repoPath, ['remote', 'set-head', remoteName, '-a'], gitEnv);
      } catch {
        // Ignore errors for set-head
      }
    } catch (error) {
      const sanitizedError = sanitizeError(error);
      logger.error({ error: sanitizedError, url, repoPath }, 'Failed to sync from remote');
      throw error; // Re-throw for Promise.allSettled handling
    }
  }

  /**
   * Sync repository from multiple remote URLs (parallelized for efficiency)
   */
  async syncFromRemotes(repoPath: string, remoteUrls: string[]): Promise<void> {
    if (remoteUrls.length === 0) return;
    
    // Sync all remotes in parallel for better performance
    const results = await Promise.allSettled(
      remoteUrls.map((url, index) => this.syncFromSingleRemote(repoPath, url, index))
    );
    
    // Log any failures but don't throw (partial success is acceptable)
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        const sanitizedError = sanitizeError(result.reason);
        logger.warn({ error: sanitizedError, url: remoteUrls[index], repoPath }, 'Failed to sync from one remote (continuing with others)');
      }
    });
  }

  /**
   * Check if force push is safe (no divergent history)
   * This is a simplified check - in production you might want more sophisticated validation
   */
  private async canSafelyForcePush(repoPath: string, remoteName: string): Promise<boolean> {
    try {
      const git = simpleGit(repoPath);
      // Fetch to see if there are any remote changes
      await git.fetch(remoteName);
      // If fetch succeeds, check if we're ahead (safe to force) or behind (dangerous)
      const status = await git.status();
      // For now, default to false (safer) unless explicitly allowed
      // In production, you'd check branch divergence more carefully
      return false;
    } catch {
      // If we can't determine, default to false (safer)
      return false;
    }
  }

  /**
   * Sync to a single remote URL with retry logic (helper for parallelization)
   */
  private async syncToSingleRemote(repoPath: string, url: string, index: number, maxRetries: number = 3): Promise<void> {
    const remoteName = `remote-${index}`;
    const git = simpleGit(repoPath);
    const gitEnv = this.getGitEnvForUrl(url);
    
    let lastError: Error | null = null;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Add remote if not exists
        try {
          await git.addRemote(remoteName, url);
        } catch {
          // Remote might already exist, that's okay
        }
        
        // Configure git proxy for this remote if it's a .onion address
        if (shouldUseTor(url)) {
          const proxy = getTorProxy();
          if (proxy) {
            try {
              await git.addConfig(`http.${url}.proxy`, `socks5://${proxy.host}:${proxy.port}`, false, 'local');
            } catch {
              // Config might fail, continue anyway
            }
          }
        }
        
        // Check if force push is safe
        const allowForce = process.env.ALLOW_FORCE_PUSH === 'true' || await this.canSafelyForcePush(repoPath, remoteName);
        const forceFlag = allowForce ? ['--force'] : [];
        
        // Push branches with appropriate environment using spawn
        await execGitWithEnv(repoPath, ['push', remoteName, '--all', ...forceFlag], gitEnv);
        
        // Push tags
        await execGitWithEnv(repoPath, ['push', remoteName, '--tags', ...forceFlag], gitEnv);
        
        // Success - return
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const sanitizedError = sanitizeError(lastError);
        
        if (attempt < maxRetries) {
          // Exponential backoff: wait 2^attempt seconds
          const delayMs = Math.pow(2, attempt) * 1000;
          logger.warn({ 
            error: sanitizedError, 
            url, 
            repoPath, 
            attempt, 
            maxRetries,
            retryIn: `${delayMs}ms`
          }, 'Failed to sync to remote, retrying...');
          
          await new Promise(resolve => setTimeout(resolve, delayMs));
        } else {
          logger.error({ error: sanitizedError, url, repoPath, attempts: maxRetries }, 'Failed to sync to remote after all retries');
          throw lastError;
        }
      }
    }
    
    throw lastError || new Error('Failed to sync to remote');
  }

  /**
   * Sync repository to multiple remote URLs after a push (parallelized with retry)
   */
  async syncToRemotes(repoPath: string, remoteUrls: string[]): Promise<void> {
    if (remoteUrls.length === 0) return;
    
    // Sync all remotes in parallel for better performance
    const results = await Promise.allSettled(
      remoteUrls.map((url, index) => this.syncToSingleRemote(repoPath, url, index))
    );
    
    // Log any failures but don't throw (partial success is acceptable)
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        const sanitizedError = sanitizeError(result.reason);
        logger.warn({ error: sanitizedError, url: remoteUrls[index], repoPath }, 'Failed to sync to one remote (continuing with others)');
      }
    });
  }

  /**
   * Normalize a clone URL to ensure it's in the correct format for git clone
   * Handles Gitea URLs that might be missing .git extension
   */
  private normalizeCloneUrl(url: string): string {
    // Remove trailing slash
    url = url.trim().replace(/\/$/, '');
    
    // For HTTPS/HTTP URLs that don't end in .git, check if they're Gitea/GitHub/GitLab style
    // Pattern: https://domain.com/owner/repo (without .git)
    if ((url.startsWith('https://') || url.startsWith('http://')) && !url.endsWith('.git')) {
      // Check if it looks like a git hosting service URL (has at least 2 path segments)
      const urlObj = new URL(url);
      const pathParts = urlObj.pathname.split('/').filter(p => p);
      
      // If it has 2+ path segments (e.g., /owner/repo), add .git
      if (pathParts.length >= 2) {
        // Check if it's not already a file or has an extension
        const lastPart = pathParts[pathParts.length - 1];
        if (!lastPart.includes('.')) {
          return `${url}.git`;
        }
      }
    }
    
    return url;
  }

  /**
   * Extract clone URLs from a NIP-34 repo announcement
   */
  private extractCloneUrls(event: NostrEvent): string[] {
    const urls: string[] = [];
    
    for (const tag of event.tags) {
      if (tag[0] === 'clone') {
        for (let i = 1; i < tag.length; i++) {
          const url = tag[i];
          if (url && typeof url === 'string') {
            // Normalize the URL to ensure it's cloneable
            urls.push(this.normalizeCloneUrl(url));
          }
        }
      }
    }
    
    return urls;
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
  /**
   * Check if a repository is private based on announcement event
   * A repo is private if it has a tag ["private"], ["private", "true"], or ["t", "private"]
   */
  private isPrivateRepo(announcement: NostrEvent): boolean {
    // Check for ["private", "true"] tag
    const privateTag = announcement.tags.find(t => t[0] === 'private' && t[1] === 'true');
    if (privateTag) return true;

    // Check for ["private"] tag (just the tag name, no value)
    const privateTagOnly = announcement.tags.find(t => t[0] === 'private' && (!t[1] || t[1] === ''));
    if (privateTagOnly) return true;

    // Check for ["t", "private"] tag (topic tag)
    const topicTag = announcement.tags.find(t => t[0] === 't' && t[1] === 'private');
    if (topicTag) return true;

    return false;
  }

  async fetchRepoOnDemand(
    npub: string,
    repoName: string,
    announcementEvent?: NostrEvent
  ): Promise<{ success: boolean; needsAnnouncement?: boolean; announcement?: NostrEvent }> {
    const repoPath = join(this.repoRoot, npub, `${repoName}.git`);
    
    // If repo already exists, check if it has an announcement
    if (existsSync(repoPath)) {
      const hasAnnouncement = await this.hasAnnouncementInRepoFile(repoPath);
      if (hasAnnouncement) {
        return { success: true };
      }
      
      // Repo exists but no announcement - try to fetch from relays
      const { requireNpubHex: requireNpubHexUtil } = await import('../../utils/npub-utils.js');
      const repoOwnerPubkey = requireNpubHexUtil(npub);
      const fetchedAnnouncement = await this.fetchAnnouncementFromRelays(repoOwnerPubkey, repoName);
      if (fetchedAnnouncement) {
        // Save fetched announcement to repo
        await this.ensureAnnouncementInRepo(repoPath, fetchedAnnouncement);
        return { success: true, announcement: fetchedAnnouncement };
      }
      
      // Repo exists but no announcement found - needs announcement
      return { success: false, needsAnnouncement: true };
    }

    // If no announcement provided, try to fetch from relays
    if (!announcementEvent) {
      const { requireNpubHex: requireNpubHexUtil } = await import('../../utils/npub-utils.js');
      const repoOwnerPubkey = requireNpubHexUtil(npub);
      const fetchedAnnouncement = await this.fetchAnnouncementFromRelays(repoOwnerPubkey, repoName);
      if (fetchedAnnouncement) {
        announcementEvent = fetchedAnnouncement;
      } else {
        // No announcement found - needs announcement
        return { success: false, needsAnnouncement: true };
      }
    }

    // Check if repository is public
    const isPublic = !this.isPrivateRepo(announcementEvent);

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

    // Extract clone URLs outside try block for error logging
    const cloneUrls = this.extractCloneUrls(announcementEvent);
    let remoteUrls: string[] = [];

    try {
      
      // Filter out localhost URLs and our own domain (we want external sources)
      const externalUrls = cloneUrls.filter(url => {
        const lowerUrl = url.toLowerCase();
        return !lowerUrl.includes('localhost') && 
               !lowerUrl.includes('127.0.0.1') && 
               !url.includes(this.domain);
      });

      // If no external URLs, try any URL that's not our domain
      remoteUrls = externalUrls.length > 0 ? externalUrls : 
                        cloneUrls.filter(url => !url.includes(this.domain));

      // If still no remote URLs, but there are *any* clone URLs, try the first one
      // This handles cases where the only clone URL is our own domain, but the repo doesn't exist locally yet
      if (remoteUrls.length === 0 && cloneUrls.length > 0) {
        logger.info({ npub, repoName, cloneUrls }, 'No external remote clone URLs found, attempting to clone from first available clone URL (may be local domain).');
        remoteUrls.push(cloneUrls[0]);
      }

      if (remoteUrls.length === 0) {
        logger.warn({ npub, repoName, cloneUrls, announcementEventId: announcementEvent.id }, 'No remote clone URLs found for on-demand fetch');
        return { success: false, needsAnnouncement: false };
      }
      
      logger.debug({ npub, repoName, cloneUrls, remoteUrls, isPublic }, 'On-demand fetch details');

      // Create directory structure
      const repoDir = join(this.repoRoot, npub);
      if (!existsSync(repoDir)) {
        mkdirSync(repoDir, { recursive: true });
      }

      // Try to clone from the first available remote URL
      // Inject authentication token if available (e.g., GITHUB_TOKEN)
      const authenticatedUrl = this.injectAuthToken(remoteUrls[0]);
      const git = simpleGit();
      const gitEnv = this.getGitEnvForUrl(authenticatedUrl);
      
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
      // Use gitEnv which already contains necessary whitelisted environment variables
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
            // Don't log the authenticated URL (might contain token)
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
        await this.ensureAnnouncementInRepo(repoPath, announcementEvent);
      } catch (verifyError) {
        // Announcement file creation is optional - log but don't fail
        logger.warn({ error: verifyError, npub, repoName }, 'Failed to ensure announcement in repo, but repository is usable');
      }

      logger.info({ npub, repoName }, 'Successfully fetched repository on-demand');
      return { success: true, announcement: announcementEvent };
    } catch (error) {
      const sanitizedError = sanitizeError(error);
      logger.error({ 
        error: sanitizedError, 
        npub, 
        repoName,
        cloneUrls,
        isPublic,
        remoteUrls
      }, 'Failed to fetch repository on-demand');
      return { success: false, needsAnnouncement: false };
    }
  }

  /**
   * Get repository size in bytes
   * Returns the total size of the repository directory
   */
  async getRepoSize(repoPath: string): Promise<number> {
    if (!existsSync(repoPath)) {
      return 0;
    }

    let totalSize = 0;

    async function calculateSize(dirPath: string): Promise<number> {
      let size = 0;
      try {
        const entries = await readdir(dirPath, { withFileTypes: true });
        
        for (const entry of entries) {
          const fullPath = join(dirPath, entry.name);
          
          if (entry.isDirectory()) {
            size += await calculateSize(fullPath);
          } else if (entry.isFile()) {
            try {
              const stats = statSync(fullPath);
              size += stats.size;
            } catch {
              // Ignore errors accessing files
            }
          }
        }
      } catch {
        // Ignore errors accessing directories
      }
      return size;
    }

    totalSize = await calculateSize(repoPath);
    return totalSize;
  }

  /**
   * Check if repository size exceeds the maximum (2 GB)
   */
  async checkRepoSizeLimit(repoPath: string, maxSizeBytes: number = 2 * 1024 * 1024 * 1024): Promise<{ withinLimit: boolean; currentSize: number; maxSize: number; error?: string }> {
    try {
      const currentSize = await this.getRepoSize(repoPath);
      const withinLimit = currentSize <= maxSizeBytes;
      
      return {
        withinLimit,
        currentSize,
        maxSize: maxSizeBytes,
        ...(withinLimit ? {} : { error: `Repository size (${(currentSize / 1024 / 1024 / 1024).toFixed(2)} GB) exceeds maximum (${(maxSizeBytes / 1024 / 1024 / 1024).toFixed(2)} GB)` })
      };
    } catch (error) {
      return {
        withinLimit: false,
        currentSize: 0,
        maxSize: maxSizeBytes,
        error: `Failed to check repository size: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  /**
   * Ensure announcement event is saved to nostr/repo-events.jsonl in the repository
   * Only saves if not already present (avoids redundant entries)
   */
  private async ensureAnnouncementInRepo(repoPath: string, event: NostrEvent, selfTransferEvent?: NostrEvent): Promise<void> {
    try {
      // Create a temporary working directory
      const repoName = this.parseRepoPathForName(repoPath)?.repoName || 'temp';
      const workDir = join(repoPath, '..', `${repoName}.work`);
      const { rm, mkdir } = await import('fs/promises');
      
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
        await workGit.push(['origin', 'main']).catch(async () => {
          // If main branch doesn't exist, create it
          await workGit.checkout(['-b', 'main']);
          await workGit.push(['origin', 'main']);
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
   * Parse repo path to extract repo name (helper for verification file creation)
   */
  private parseRepoPathForName(repoPath: string): { repoName: string } | null {
    const match = repoPath.match(/\/([^\/]+)\.git$/);
    if (!match) return null;
    return { repoName: match[1] };
  }

  /**
   * Check if an announcement event already exists in nostr/repo-events.jsonl
   */
  private async hasAnnouncementInRepo(worktreePath: string, eventId?: string): Promise<boolean> {
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
  private async getAnnouncementFromRepo(worktreePath: string): Promise<NostrEvent | null> {
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
  private async fetchAnnouncementFromRelays(
    repoOwnerPubkey: string,
    repoName: string
  ): Promise<NostrEvent | null> {
    try {
      const { NostrClient } = await import('../nostr/nostr-client.js');
      const { DEFAULT_NOSTR_RELAYS } = await import('../../config.js');
      const { KIND } = await import('../../types/nostr.js');
      
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
  private async saveRepoEventToWorktree(
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
      
      const { mkdir, writeFile } = await import('fs/promises');
      
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
   * Check if a repository already has an announcement in nostr/repo-events.jsonl
   * Used to determine if this is a truly new repo or an existing one being added
   */
  async hasAnnouncementInRepoFile(repoPath: string): Promise<boolean> {
    if (!this.repoExists(repoPath)) {
      return false;
    }

    try {
      const git: SimpleGit = simpleGit();
      const repoName = this.parseRepoPathForName(repoPath)?.repoName || 'temp';
      const workDir = join(repoPath, '..', `${repoName}.check`);
      const { rm, mkdir } = await import('fs/promises');
      
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
