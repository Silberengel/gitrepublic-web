/**
 * Repository manager for git repositories
 * Handles repo provisioning, syncing, and NIP-34 integration
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdirSync, writeFileSync, statSync } from 'fs';
import { join } from 'path';
import { readdir } from 'fs/promises';
import type { NostrEvent } from '../../types/nostr.js';
import { GIT_DOMAIN } from '../../config.js';
import { generateVerificationFile, VERIFICATION_FILE_PATH } from '../nostr/repo-verification.js';
import simpleGit, { type SimpleGit } from 'simple-git';

const execAsync = promisify(exec);

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
   */
  async provisionRepo(event: NostrEvent): Promise<void> {
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

    // Create bare repository if it doesn't exist
    const isNewRepo = !existsSync(repoPath.fullPath);
    if (isNewRepo) {
      await execAsync(`git init --bare "${repoPath.fullPath}"`);
      
      // Create verification file in the repository
      await this.createVerificationFile(repoPath.fullPath, event);
    }

    // If there are other clone URLs, sync from them
    const otherUrls = cloneUrls.filter(url => !url.includes(this.domain));
    if (otherUrls.length > 0) {
      await this.syncFromRemotes(repoPath.fullPath, otherUrls);
    }
  }

  /**
   * Sync repository from multiple remote URLs
   */
  async syncFromRemotes(repoPath: string, remoteUrls: string[]): Promise<void> {
    for (const url of remoteUrls) {
      try {
        // Add remote if not exists
        const remoteName = `remote-${remoteUrls.indexOf(url)}`;
        await execAsync(`cd "${repoPath}" && git remote add ${remoteName} "${url}" || true`);
        
        // Fetch from remote
        await execAsync(`cd "${repoPath}" && git fetch ${remoteName} --all`);
        
        // Update all branches
        await execAsync(`cd "${repoPath}" && git remote set-head ${remoteName} -a`);
      } catch (error) {
        console.error(`Failed to sync from ${url}:`, error);
        // Continue with other remotes
      }
    }
  }

  /**
   * Sync repository to multiple remote URLs after a push
   */
  async syncToRemotes(repoPath: string, remoteUrls: string[]): Promise<void> {
    for (const url of remoteUrls) {
      try {
        const remoteName = `remote-${remoteUrls.indexOf(url)}`;
        await execAsync(`cd "${repoPath}" && git remote add ${remoteName} "${url}" || true`);
        await execAsync(`cd "${repoPath}" && git push ${remoteName} --all --force`);
        await execAsync(`cd "${repoPath}" && git push ${remoteName} --tags --force`);
      } catch (error) {
        console.error(`Failed to sync to ${url}:`, error);
        // Continue with other remotes
      }
    }
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
   * Create verification file in a new repository
   * This proves the repository is owned by the announcement author
   */
  private async createVerificationFile(repoPath: string, event: NostrEvent): Promise<void> {
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

      // Commit the verification file
      const workGit: SimpleGit = simpleGit(workDir);
      await workGit.add(VERIFICATION_FILE_PATH);
      
      // Use the event timestamp for commit date
      const commitDate = new Date(event.created_at * 1000).toISOString();
      await workGit.commit('Add Nostr repository verification file', [VERIFICATION_FILE_PATH], {
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
      console.error('Failed to create verification file:', error);
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
}
