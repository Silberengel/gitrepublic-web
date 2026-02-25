/**
 * Git Remote Synchronization Service
 * Handles syncing repositories to/from remote URLs
 */

import { spawn } from 'child_process';
import simpleGit, { type SimpleGit } from 'simple-git';
import logger from '../logger.js';
import { shouldUseTor, getTorProxy } from '../../utils/tor.js';
import { sanitizeError } from '../../utils/security.js';
import { RepoUrlParser } from './repo-url-parser.js';

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
      stdio: ['ignore', 'pipe', 'pipe'],
      // Ensure detached process group to prevent zombie processes
      detached: false
    });

    let stdout = '';
    let stderr = '';
    let resolved = false;

    // Set a timeout to prevent hanging processes (30 minutes for long operations)
    const timeoutMs = 30 * 60 * 1000;
    const timeoutId = setTimeout(() => {
      if (!resolved && !gitProcess.killed) {
        resolved = true;
        // Kill the process tree to prevent zombies
        try {
          gitProcess.kill('SIGTERM');
          // Force kill after grace period
          setTimeout(() => {
            if (!gitProcess.killed) {
              gitProcess.kill('SIGKILL');
            }
          }, 5000);
        } catch (err) {
          // Process might already be dead
        }
        reject(new Error(`Git command timeout after ${timeoutMs}ms: ${args.join(' ')}`));
      }
    }, timeoutMs);

    gitProcess.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    gitProcess.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    gitProcess.on('close', (code, signal) => {
      clearTimeout(timeoutId);
      if (resolved) return;
      resolved = true;
      
      // Ensure process is fully cleaned up
      if (gitProcess.pid && !gitProcess.killed) {
        try {
          // Wait for any remaining child processes
          process.kill(gitProcess.pid, 0); // Check if process exists
        } catch {
          // Process already dead, that's fine
        }
      }
      
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const errorMsg = signal 
          ? `Git command terminated by signal ${signal}: ${stderr || stdout}`
          : `Git command failed with code ${code}: ${stderr || stdout}`;
        reject(new Error(errorMsg));
      }
    });

    gitProcess.on('error', (err) => {
      clearTimeout(timeoutId);
      if (resolved) return;
      resolved = true;
      reject(err);
    });

    // Handle process exit (backup to 'close' event)
    gitProcess.on('exit', (code, signal) => {
      // This is handled by 'close' event, but ensures we catch all cases
      if (!resolved && code !== null && code !== 0) {
        clearTimeout(timeoutId);
        resolved = true;
        const errorMsg = signal 
          ? `Git command terminated by signal ${signal}: ${stderr || stdout}`
          : `Git command failed with code ${code}: ${stderr || stdout}`;
        reject(new Error(errorMsg));
      }
    });
  });
}

/**
 * Git Remote Synchronization Service
 * Handles syncing repositories to and from remote URLs
 */
export class GitRemoteSync {
  private urlParser: RepoUrlParser;

  constructor(repoRoot: string = '/repos', domain: string = 'localhost:6543') {
    this.urlParser = new RepoUrlParser(repoRoot, domain);
  }

  /**
   * Get git environment variables with Tor proxy if needed for .onion addresses
   * Security: Only whitelist necessary environment variables
   */
  getGitEnvForUrl(url: string): Record<string, string> {
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
   * Inject authentication token into a git URL if needed
   * Supports GitHub tokens via GITHUB_TOKEN environment variable
   * Returns the original URL if no token is needed or available
   */
  injectAuthToken(url: string): string {
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
      // Note: 'git fetch <remote>' already fetches all branches from that remote
      // The --all flag is only for fetching from all remotes (without specifying a remote)
      await execGitWithEnv(repoPath, ['fetch', remoteName], gitEnv);
      
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
   * A force push is safe if:
   * - Local branch is ahead of remote (linear history, just new commits)
   * - Local and remote are at the same commit (no-op)
   * A force push is unsafe if:
   * - Remote has commits that local doesn't have (would overwrite remote history)
   */
  private async canSafelyForcePush(repoPath: string, remoteName: string): Promise<boolean> {
    try {
      const git = simpleGit(repoPath);
      
      // Get current branch name
      const currentBranch = await git.revparse(['--abbrev-ref', 'HEAD']);
      if (!currentBranch) {
        return false; // Can't determine current branch
      }
      
      // Fetch latest remote state
      await git.fetch(remoteName);
      
      // Get remote branch reference
      const remoteBranch = `${remoteName}/${currentBranch}`;
      
      // Check if remote branch exists
      try {
        await git.revparse([`refs/remotes/${remoteBranch}`]);
      } catch {
        // Remote branch doesn't exist yet - safe to push (first push)
        return true;
      }
      
      // Get local and remote commit SHAs
      const localSha = await git.revparse(['HEAD']);
      const remoteSha = await git.revparse([`refs/remotes/${remoteBranch}`]);
      
      // If they're the same, it's safe (no-op)
      if (localSha === remoteSha) {
        return true;
      }
      
      // Check if local is ahead (linear history) - safe to force push
      // This means all remote commits are ancestors of local commits
      const mergeBase = await git.raw(['merge-base', localSha, remoteSha]);
      const mergeBaseSha = mergeBase.trim();
      
      // If merge base equals remote SHA, local is ahead (safe)
      if (mergeBaseSha === remoteSha) {
        return true;
      }
      
      // If merge base equals local SHA, remote is ahead (unsafe to force push)
      if (mergeBaseSha === localSha) {
        return false;
      }
      
      // If merge base is different from both, branches have diverged (unsafe)
      return false;
    } catch (error) {
      // If we can't determine, default to false (safer)
      logger.warn({ error, repoPath, remoteName }, 'Failed to check branch divergence, defaulting to unsafe');
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
}
