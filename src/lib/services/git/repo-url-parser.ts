/**
 * Repository URL Parser
 * Handles parsing and validation of repository URLs
 */

import { join } from 'path';
import { GIT_DOMAIN } from '../../config.js';
import { extractCloneUrls } from '../../utils/nostr-utils.js';
import type { NostrEvent } from '../../types/nostr.js';

export interface RepoPath {
  npub: string;
  repoName: string;
  fullPath: string;
}

/**
 * Check if a URL is a GRASP (Git Repository Access via Secure Protocol) URL
 * GRASP URLs contain npub (Nostr public key) in the path: https://host/npub.../repo.git
 */
export function isGraspUrl(url: string): boolean {
  // GRASP URLs have npub (starts with npub1) in the path
  return /\/npub1[a-z0-9]+/i.test(url);
}

/**
 * Repository URL Parser
 * Handles parsing git domain URLs and extracting repository information
 */
export class RepoUrlParser {
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
   * Extract clone URLs from a NIP-34 repo announcement
   * Uses shared utility with normalization enabled
   */
  extractCloneUrls(event: NostrEvent): string[] {
    return extractCloneUrls(event, true);
  }

  /**
   * Convert SSH URL to HTTPS URL if possible
   * e.g., git@github.com:user/repo.git -> https://github.com/user/repo.git
   */
  convertSshToHttps(url: string): string | null {
    // Check if it's an SSH URL (git@host:path or ssh://)
    const sshMatch = url.match(/^git@([^:]+):(.+)$/);
    if (sshMatch) {
      const [, host, path] = sshMatch;
      // Remove .git suffix if present, we'll add it back
      const cleanPath = path.replace(/\.git$/, '');
      return `https://${host}/${cleanPath}.git`;
    }
    
    // Check for ssh:// URLs
    if (url.startsWith('ssh://')) {
      const sshUrlMatch = url.match(/^ssh:\/\/([^/]+)\/(.+)$/);
      if (sshUrlMatch) {
        const [, host, path] = sshUrlMatch;
        const cleanPath = path.replace(/\.git$/, '');
        return `https://${host}/${cleanPath}.git`;
      }
    }
    
    return null;
  }

  /**
   * Filter and prepare remote URLs from clone URLs
   * Respects the repo owner's order in the clone list
   */
  prepareRemoteUrls(cloneUrls: string[]): string[] {
    const httpsUrls: string[] = [];
    const sshUrls: string[] = [];
    
    for (const url of cloneUrls) {
      const lowerUrl = url.toLowerCase();
      
      // Skip localhost and our own domain
      if (lowerUrl.includes('localhost') || 
          lowerUrl.includes('127.0.0.1') || 
          url.includes(this.domain)) {
        continue;
      }
      
      // Check if it's an SSH URL
      if (url.startsWith('git@') || url.startsWith('ssh://')) {
        sshUrls.push(url);
        // Try to convert to HTTPS (preserve original order by appending)
        const httpsUrl = this.convertSshToHttps(url);
        if (httpsUrl) {
          httpsUrls.push(httpsUrl);
        }
      } else {
        // It's already HTTPS/HTTP - preserve original order
        httpsUrls.push(url);
      }
    }
    
    // Respect the repo owner's order: use HTTPS URLs in the order they appeared in clone list
    let remoteUrls = httpsUrls;
    
    // If no HTTPS URLs, try SSH URLs (but log a warning)
    if (remoteUrls.length === 0 && sshUrls.length > 0) {
      remoteUrls = sshUrls;
    }

    // If no external URLs, try any URL that's not our domain (preserve order)
    if (remoteUrls.length === 0) {
      remoteUrls = cloneUrls.filter(url => !url.includes(this.domain));
    }

    // If still no remote URLs, but there are *any* clone URLs, try the first one
    // This handles cases where the only clone URL is our own domain, but the repo doesn't exist locally yet
    if (remoteUrls.length === 0 && cloneUrls.length > 0) {
      remoteUrls.push(cloneUrls[0]);
    }

    return remoteUrls;
  }

  /**
   * Parse repo path to extract repo name (helper for verification file creation)
   */
  parseRepoPathForName(repoPath: string): { repoName: string } | null {
    const match = repoPath.match(/\/([^\/]+)\.git$/);
    if (!match) return null;
    return { repoName: match[1] };
  }
}
