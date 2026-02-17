/**
 * Resource limits service
 * Tracks and enforces per-user resource limits
 */

import { statSync } from 'fs';
import { join } from 'path';
import { readdir } from 'fs/promises';

export interface ResourceUsage {
  repoCount: number;
  diskUsage: number; // bytes
  maxRepos: number;
  maxDiskQuota: number; // bytes
}

export class ResourceLimits {
  private repoRoot: string;
  private maxReposPerUser: number;
  private maxDiskQuotaPerUser: number;
  private cache: Map<string, { usage: ResourceUsage; timestamp: number }> = new Map();
  private cacheTTL = 5 * 60 * 1000; // 5 minutes

  constructor(repoRoot: string = '/repos') {
    this.repoRoot = repoRoot;
    this.maxReposPerUser = parseInt(process.env.MAX_REPOS_PER_USER || '100', 10);
    this.maxDiskQuotaPerUser = parseInt(process.env.MAX_DISK_QUOTA_PER_USER || '10737418240', 10); // 10GB default
  }

  /**
   * Get resource usage for a user (npub)
   */
  async getUsage(npub: string): Promise<ResourceUsage> {
    const cacheKey = npub;
    const cached = this.cache.get(cacheKey);
    const now = Date.now();

    if (cached && (now - cached.timestamp) < this.cacheTTL) {
      return cached.usage;
    }

    const userRepoDir = join(this.repoRoot, npub);
    let repoCount = 0;
    let diskUsage = 0;

    try {
      // Count repositories
      if (await this.dirExists(userRepoDir)) {
        const entries = await readdir(userRepoDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && entry.name.endsWith('.git')) {
            repoCount++;
            // Calculate disk usage for this repo
            try {
              const repoPath = join(userRepoDir, entry.name);
              diskUsage += this.calculateDirSize(repoPath);
            } catch {
              // Ignore errors calculating size
            }
          }
        }
      }
    } catch {
      // User directory doesn't exist yet, usage is 0
    }

    const usage: ResourceUsage = {
      repoCount,
      diskUsage,
      maxRepos: this.maxReposPerUser,
      maxDiskQuota: this.maxDiskQuotaPerUser
    };

    this.cache.set(cacheKey, { usage, timestamp: now });
    return usage;
  }

  /**
   * Check if user can create a new repository
   */
  async canCreateRepo(npub: string): Promise<{ allowed: boolean; reason?: string; usage: ResourceUsage }> {
    const usage = await this.getUsage(npub);

    if (usage.repoCount >= usage.maxRepos) {
      return {
        allowed: false,
        reason: `Repository limit reached (${usage.repoCount}/${usage.maxRepos})`,
        usage
      };
    }

    return { allowed: true, usage };
  }

  /**
   * Check if user has enough disk quota
   */
  async hasDiskQuota(npub: string, additionalBytes: number = 0): Promise<{ allowed: boolean; reason?: string; usage: ResourceUsage }> {
    const usage = await this.getUsage(npub);

    if (usage.diskUsage + additionalBytes > usage.maxDiskQuota) {
      return {
        allowed: false,
        reason: `Disk quota exceeded (${this.formatBytes(usage.diskUsage)}/${this.formatBytes(usage.maxDiskQuota)})`,
        usage
      };
    }

    return { allowed: true, usage };
  }

  /**
   * Invalidate cache for a user (call after repo operations)
   */
  invalidateCache(npub: string): void {
    this.cache.delete(npub);
  }

  /**
   * Calculate directory size recursively
   */
  private calculateDirSize(dirPath: string): number {
    try {
      let size = 0;
      const stats = statSync(dirPath);
      
      if (stats.isFile()) {
        return stats.size;
      }

      if (stats.isDirectory()) {
        // For performance, we'll do a simplified calculation
        // In production, you might want to use a more efficient method
        // or cache this calculation
        try {
          const entries = require('fs').readdirSync(dirPath);
          for (const entry of entries) {
            try {
              size += this.calculateDirSize(join(dirPath, entry));
            } catch {
              // Ignore errors (permissions, symlinks, etc.)
            }
          }
        } catch {
          // Can't read directory
        }
      }

      return size;
    } catch {
      return 0;
    }
  }

  /**
   * Check if directory exists
   */
  private async dirExists(path: string): Promise<boolean> {
    try {
      const stats = await import('fs/promises').then(m => m.stat(path));
      return stats.isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Format bytes to human-readable string
   */
  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  }
}
