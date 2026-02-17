/**
 * Repository manager for git repositories
 * Handles repo provisioning, syncing, and NIP-34 integration
 */

import { existsSync, mkdirSync, writeFileSync, statSync } from 'fs';
import { join } from 'path';
import { readdir } from 'fs/promises';
import { spawn } from 'child_process';
import type { NostrEvent } from '../../types/nostr.js';
import { GIT_DOMAIN } from '../../config.js';
import { generateVerificationFile, VERIFICATION_FILE_PATH } from '../nostr/repo-verification.js';
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
    
    // If there are other clone URLs, sync from them first (for existing repos)
    const otherUrls = cloneUrls.filter(url => !url.includes(this.domain));
    if (otherUrls.length > 0 && repoExists) {
      // For existing repos, sync first to get the latest state
      await this.syncFromRemotes(repoPath.fullPath, otherUrls);
    }

    // Create bare repository if it doesn't exist
    const isNewRepo = !repoExists;
    if (isNewRepo) {
      // Use simple-git to create bare repo (safer than exec)
      const git = simpleGit();
      await git.init(['--bare', repoPath.fullPath]);
      
      // Create verification file and self-transfer event in the repository
      await this.createVerificationFile(repoPath.fullPath, event, selfTransferEvent);
      
      // If there are other clone URLs, sync from them after creating the repo
      if (otherUrls.length > 0) {
        await this.syncFromRemotes(repoPath.fullPath, otherUrls);
      }
    } else if (isExistingRepo && selfTransferEvent) {
      // For existing repos, we might want to add the self-transfer event
      // But we should be careful not to overwrite existing history
      // For now, we'll just ensure the verification file exists
      // The self-transfer event should already be published to relays
      logger.info({ repoPath: repoPath.fullPath }, 'Existing repo - self-transfer event should be published to relays');
    }
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
    const gitEnv = this.getGitEnvForUrl(url);
    
    try {
      // Add remote if not exists (ignore error if already exists)
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
   * Extract clone URLs from a NIP-34 repo announcement
   */
  private extractCloneUrls(event: NostrEvent): string[] {
    const urls: string[] = [];
    
    for (const tag of event.tags) {
      if (tag[0] === 'clone') {
        for (let i = 1; i < tag.length; i++) {
          const url = tag[i];
          if (url && typeof url === 'string') {
            urls.push(url);
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
   * Create verification file and self-transfer event in a new repository
   * This proves the repository is owned by the announcement author
   */
  private async createVerificationFile(repoPath: string, event: NostrEvent, selfTransferEvent?: NostrEvent): Promise<void> {
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

      // Generate verification file content
      const verificationContent = generateVerificationFile(event, event.pubkey);

      // Write verification file
      const verificationPath = join(workDir, VERIFICATION_FILE_PATH);
      writeFileSync(verificationPath, verificationContent, 'utf-8');

      // If self-transfer event is provided, include it in the commit
      const filesToAdd = [VERIFICATION_FILE_PATH];
      if (selfTransferEvent) {
        const selfTransferPath = join(workDir, '.nostr-ownership-transfer');
        const isTemplate = !selfTransferEvent.sig || !selfTransferEvent.id;
        
        const selfTransferContent = JSON.stringify({
          eventId: selfTransferEvent.id || '(unsigned - needs owner signature)',
          pubkey: selfTransferEvent.pubkey,
          signature: selfTransferEvent.sig || '(unsigned - needs owner signature)',
          timestamp: selfTransferEvent.created_at,
          kind: selfTransferEvent.kind,
          content: selfTransferEvent.content,
          tags: selfTransferEvent.tags,
          ...(isTemplate ? {
            _note: 'This is a template. The owner must sign and publish this event to relays for it to be valid.',
            _instructions: 'To publish: 1. Sign this event with your private key, 2. Publish to relays using your Nostr client'
          } : {})
        }, null, 2) + '\n';
        writeFileSync(selfTransferPath, selfTransferContent, 'utf-8');
        filesToAdd.push('.nostr-ownership-transfer');
      }

      // Commit the verification file and self-transfer event
      const workGit: SimpleGit = simpleGit(workDir);
      await workGit.add(filesToAdd);
      
      // Use the event timestamp for commit date
      const commitDate = new Date(event.created_at * 1000).toISOString();
      let commitMessage = selfTransferEvent 
        ? 'Add Nostr repository verification and initial ownership proof'
        : 'Add Nostr repository verification file';
      
      // Sign commit if nsec key is provided (from environment or event)
      // Note: For initial commits, we might not have the user's nsec, so this is optional
      const nsecKey = process.env.NOSTRGIT_SECRET_KEY;
      if (nsecKey) {
        try {
          const { createGitCommitSignature } = await import('./commit-signer.js');
          const { signedMessage } = await createGitCommitSignature(
            commitMessage,
            'Nostr',
            `${event.pubkey}@nostr`,
            {
              nsecKey,
              timestamp: event.created_at
            }
          );
          commitMessage = signedMessage;
        } catch (err) {
          logger.warn({ error: err, repoPath }, 'Failed to sign initial commit');
          // Continue without signature if signing fails
        }
      }
      
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

      // Clean up
      await rm(workDir, { recursive: true, force: true });
    } catch (error) {
      logger.error({ error, repoPath }, 'Failed to create verification file');
      // Don't throw - verification file creation is important but shouldn't block provisioning
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
   * Check if a repository already has a verification file
   * Used to determine if this is a truly new repo or an existing one being added
   */
  async hasVerificationFile(repoPath: string): Promise<boolean> {
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

      // Try to clone and check for verification file
      await git.clone(repoPath, workDir);
      const verificationPath = join(workDir, VERIFICATION_FILE_PATH);
      const hasFile = existsSync(verificationPath);

      // Clean up
      await rm(workDir, { recursive: true, force: true });
      
      return hasFile;
    } catch {
      // If we can't check, assume it doesn't have one
      return false;
    }
  }
}
