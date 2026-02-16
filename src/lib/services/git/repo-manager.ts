/**
 * Repository manager for git repositories
 * Handles repo provisioning, syncing, and NIP-34 integration
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { NostrEvent } from '../../types/nostr.js';
import { GIT_DOMAIN } from '../../config.js';

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
    if (!existsSync(repoPath.fullPath)) {
      await execAsync(`git init --bare "${repoPath.fullPath}"`);
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
}
