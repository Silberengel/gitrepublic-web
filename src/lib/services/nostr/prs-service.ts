/**
 * Service for managing NIP-34 Pull Requests (kind 1618)
 */

import { NostrClient } from './nostr-client.js';
import { KIND } from '../../types/nostr.js';
import type { PullRequest, NostrEvent, StatusEvent } from '../../types/nostr.js';
import { signEventWithNIP07 } from './nip07-signer.js';

export interface PRWithStatus extends PullRequest {
  status: 'open' | 'merged' | 'closed' | 'draft';
  statusEvent?: StatusEvent;
}

export class PRsService {
  private nostrClient: NostrClient;
  private relays: string[];

  constructor(relays: string[] = []) {
    this.relays = relays;
    this.nostrClient = new NostrClient(relays);
  }

  /**
   * Get repository announcement address (a tag format)
   */
  private getRepoAddress(repoOwnerPubkey: string, repoId: string): string {
    return `${KIND.REPO_ANNOUNCEMENT}:${repoOwnerPubkey}:${repoId}`;
  }

  /**
   * Get earliest unique commit ID from repo announcement
   */
  private getEarliestUniqueCommit(announcement: NostrEvent): string | null {
    const eucTag = announcement.tags.find(t => t[0] === 'r' && t[2] === 'euc');
    return eucTag?.[1] || null;
  }

  /**
   * Fetch pull requests for a repository
   */
  async getPullRequests(repoOwnerPubkey: string, repoId: string): Promise<PRWithStatus[]> {
    const repoAddress = this.getRepoAddress(repoOwnerPubkey, repoId);
    
    const prs = await this.nostrClient.fetchEvents([
      {
        kinds: [KIND.PULL_REQUEST],
        '#a': [repoAddress],
        limit: 100
      }
    ]) as PullRequest[];

    // Fetch status events for each PR
    const prIds = prs.map(pr => pr.id);
    const statusEvents = await this.nostrClient.fetchEvents([
      {
        kinds: [KIND.STATUS_OPEN, KIND.STATUS_APPLIED, KIND.STATUS_CLOSED, KIND.STATUS_DRAFT],
        '#e': prIds,
        limit: 1000
      }
    ]) as StatusEvent[];

    // Group status events by PR ID and get the most recent one
    const statusMap = new Map<string, StatusEvent>();
    for (const status of statusEvents) {
      const rootTag = status.tags.find(t => t[0] === 'e' && t[3] === 'root');
      if (rootTag && rootTag[1]) {
        const prId = rootTag[1];
        const existing = statusMap.get(prId);
        if (!existing || status.created_at > existing.created_at) {
          statusMap.set(prId, status);
        }
      }
    }

    // Combine PRs with their status
    return prs.map(pr => {
      const statusEvent = statusMap.get(pr.id);
      let status: 'open' | 'merged' | 'closed' | 'draft' = 'open';
      
      if (statusEvent) {
        if (statusEvent.kind === KIND.STATUS_OPEN) status = 'open';
        else if (statusEvent.kind === KIND.STATUS_APPLIED) status = 'merged';
        else if (statusEvent.kind === KIND.STATUS_CLOSED) status = 'closed';
        else if (statusEvent.kind === KIND.STATUS_DRAFT) status = 'draft';
      }

      return {
        ...pr,
        status,
        statusEvent
      };
    });
  }

  /**
   * Create a new pull request
   */
  async createPullRequest(
    repoOwnerPubkey: string,
    repoId: string,
    subject: string,
    content: string,
    commitId: string,
    cloneUrl: string,
    branchName?: string,
    labels: string[] = []
  ): Promise<PullRequest> {
    const repoAddress = this.getRepoAddress(repoOwnerPubkey, repoId);
    
    const tags: string[][] = [
      ['a', repoAddress],
      ['p', repoOwnerPubkey],
      ['subject', subject],
      ['c', commitId],
      ['clone', cloneUrl]
    ];

    if (branchName) {
      tags.push(['branch-name', branchName]);
    }

    // Add labels
    for (const label of labels) {
      tags.push(['t', label]);
    }

    const event = await signEventWithNIP07({
      kind: KIND.PULL_REQUEST,
      content,
      tags,
      created_at: Math.floor(Date.now() / 1000),
      pubkey: ''
    });

    const result = await this.nostrClient.publishEvent(event, this.relays);
    if (result.failed.length > 0 && result.success.length === 0) {
      throw new Error('Failed to publish pull request to all relays');
    }

    return event as PullRequest;
  }

  /**
   * Update PR status
   */
  async updatePRStatus(
    prId: string,
    prAuthor: string,
    repoOwnerPubkey: string,
    repoId: string,
    status: 'open' | 'merged' | 'closed' | 'draft',
    mergeCommitId?: string
  ): Promise<StatusEvent> {
    const repoAddress = this.getRepoAddress(repoOwnerPubkey, repoId);
    
    let kind: number;
    switch (status) {
      case 'open':
        kind = KIND.STATUS_OPEN;
        break;
      case 'merged':
        kind = KIND.STATUS_APPLIED;
        break;
      case 'closed':
        kind = KIND.STATUS_CLOSED;
        break;
      case 'draft':
        kind = KIND.STATUS_DRAFT;
        break;
    }

    const tags: string[][] = [
      ['e', prId, '', 'root'],
      ['p', repoOwnerPubkey],
      ['p', prAuthor],
      ['a', repoAddress]
    ];

    // Note: earliest unique commit should be added by caller if available
    // We don't have access to repo announcement here, so it's optional

    if (status === 'merged' && mergeCommitId) {
      tags.push(['merge-commit', mergeCommitId]);
      tags.push(['r', mergeCommitId]);
    }

    const event = await signEventWithNIP07({
      kind,
      content: `Pull request ${status}`,
      tags,
      created_at: Math.floor(Date.now() / 1000),
      pubkey: ''
    });

    const result = await this.nostrClient.publishEvent(event, this.relays);
    if (result.failed.length > 0 && result.success.length === 0) {
      throw new Error('Failed to publish status update to all relays');
    }

    return event as StatusEvent;
  }
}
