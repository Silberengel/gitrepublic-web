/**
 * Service for managing branch protection rules
 * Stores rules in Nostr events (kind 30620)
 */

import { NostrClient } from './nostr-client.js';
import { KIND } from '../../types/nostr.js';
import type { NostrEvent } from '../../types/nostr.js';
import logger from '../logger.js';

export interface BranchProtectionRule {
  branch: string;
  requirePullRequest: boolean;
  requireReviewers?: string[]; // Array of pubkeys
  allowForcePush: boolean;
  requireStatusChecks?: string[]; // Array of status check names
  allowedMaintainers?: string[]; // Override: specific maintainers who can push directly
}

export interface BranchProtectionConfig {
  repoTag: string; // Format: "{KIND.REPO_ANNOUNCEMENT}:{owner}:{repo}"
  rules: BranchProtectionRule[];
}

export class BranchProtectionService {
  private nostrClient: NostrClient;

  constructor(relays: string[]) {
    this.nostrClient = new NostrClient(relays);
  }

  /**
   * Get branch protection rules for a repository
   */
  async getBranchProtection(ownerPubkey: string, repoName: string): Promise<BranchProtectionConfig | null> {
    const repoTag = `${KIND.REPO_ANNOUNCEMENT}:${ownerPubkey}:${repoName}`;

    try {
      const events = await this.nostrClient.fetchEvents([
        {
          kinds: [KIND.BRANCH_PROTECTION],
          authors: [ownerPubkey],
          '#a': [repoTag],
          limit: 1
        }
      ]);

      if (events.length === 0) {
        return null; // No protection rules
      }

      const event = events[0];
      return this.parseProtectionEvent(event);
    } catch (error) {
      logger.error({ error, ownerPubkey, repoName }, 'Error fetching branch protection');
      return null;
    }
  }

  /**
   * Check if a branch is protected
   */
  async isBranchProtected(ownerPubkey: string, repoName: string, branchName: string): Promise<boolean> {
    const config = await this.getBranchProtection(ownerPubkey, repoName);
    if (!config) return false;

    return config.rules.some(rule => rule.branch === branchName);
  }

  /**
   * Check if a user can push to a protected branch
   */
  async canPushToBranch(
    userPubkey: string,
    ownerPubkey: string,
    repoName: string,
    branchName: string,
    isMaintainer: boolean
  ): Promise<{ allowed: boolean; reason?: string }> {
    const config = await this.getBranchProtection(ownerPubkey, repoName);
    if (!config) {
      // No protection rules, allow if maintainer
      return { allowed: isMaintainer || userPubkey === ownerPubkey };
    }

    const rule = config.rules.find(r => r.branch === branchName);
    if (!rule) {
      // Branch not protected, allow if maintainer
      return { allowed: isMaintainer || userPubkey === ownerPubkey };
    }

    // Owner can always push (bypass protection)
    if (userPubkey === ownerPubkey) {
      return { allowed: true };
    }

    // Check if user is in allowed maintainers list
    if (rule.allowedMaintainers && rule.allowedMaintainers.includes(userPubkey)) {
      return { allowed: true };
    }

    // Protected branch requires pull request
    if (rule.requirePullRequest) {
      return {
        allowed: false,
        reason: `Branch "${branchName}" is protected. Please create a pull request instead of pushing directly.`
      };
    }

    // If no PR requirement, allow maintainers
    return { allowed: isMaintainer };
  }

  /**
   * Create a branch protection event
   */
  createProtectionEvent(
    ownerPubkey: string,
    repoName: string,
    rules: BranchProtectionRule[]
  ): Omit<NostrEvent, 'sig' | 'id'> {
    const repoTag = `${KIND.REPO_ANNOUNCEMENT}:${ownerPubkey}:${repoName}`;
    const tags: string[][] = [
      ['d', repoName],
      ['a', repoTag]
    ];

    // Add rules as tags
    for (const rule of rules) {
      tags.push(['branch', rule.branch]);
      if (rule.requirePullRequest) {
        tags.push(['branch', rule.branch, 'require-pr']);
      }
      if (rule.allowForcePush) {
        tags.push(['branch', rule.branch, 'allow-force-push']);
      }
      if (rule.requireReviewers && rule.requireReviewers.length > 0) {
        tags.push(['branch', rule.branch, 'require-reviewers', ...rule.requireReviewers]);
      }
      if (rule.requireStatusChecks && rule.requireStatusChecks.length > 0) {
        tags.push(['branch', rule.branch, 'require-status', ...rule.requireStatusChecks]);
      }
      if (rule.allowedMaintainers && rule.allowedMaintainers.length > 0) {
        tags.push(['branch', rule.branch, 'allowed-maintainers', ...rule.allowedMaintainers]);
      }
    }

    return {
      kind: KIND.BRANCH_PROTECTION,
      pubkey: ownerPubkey,
      created_at: Math.floor(Date.now() / 1000),
      content: JSON.stringify(rules), // Also store as JSON for easy parsing
      tags
    };
  }

  /**
   * Parse a branch protection event into a config
   */
  private parseProtectionEvent(event: NostrEvent): BranchProtectionConfig {
    const repoTag = event.tags.find(t => t[0] === 'a')?.[1] || '';
    const rules: BranchProtectionRule[] = [];

    // Try to parse from content first (JSON)
    try {
      const parsed = JSON.parse(event.content);
      if (Array.isArray(parsed)) {
        return { repoTag, rules: parsed };
      }
    } catch {
      // Fall back to parsing tags
    }

    // Parse from tags
    const branchTags = event.tags.filter(t => t[0] === 'branch');
    const branches = new Set(branchTags.map(t => t[1]));

    for (const branch of branches) {
      const branchTags = event.tags.filter(t => t[0] === 'branch' && t[1] === branch);
      
      const rule: BranchProtectionRule = {
        branch,
        requirePullRequest: branchTags.some(t => t[2] === 'require-pr'),
        allowForcePush: branchTags.some(t => t[2] === 'allow-force-push'),
        requireReviewers: [],
        requireStatusChecks: [],
        allowedMaintainers: []
      };

      for (const tag of branchTags) {
        if (tag[2] === 'require-reviewers') {
          rule.requireReviewers = tag.slice(3).filter(p => p && typeof p === 'string') as string[];
        } else if (tag[2] === 'require-status') {
          rule.requireStatusChecks = tag.slice(3).filter(s => s && typeof s === 'string') as string[];
        } else if (tag[2] === 'allowed-maintainers') {
          rule.allowedMaintainers = tag.slice(3).filter(m => m && typeof m === 'string') as string[];
        }
      }

      rules.push(rule);
    }

    return { repoTag, rules };
  }
}
