/**
 * Service for managing NIP-34 Issues (kind 1621)
 */

import { NostrClient } from './nostr-client.js';
import { KIND } from '../../types/nostr.js';
import type { Issue, NostrEvent, StatusEvent } from '../../types/nostr.js';
import { signEventWithNIP07 } from './nip07-signer.js';

export interface IssueWithStatus extends Issue {
  status: 'open' | 'closed' | 'resolved' | 'draft';
  statusEvent?: StatusEvent;
}

export class IssuesService {
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
    return `30617:${repoOwnerPubkey}:${repoId}`;
  }

  /**
   * Extract repo address from event tags
   */
  private extractRepoAddress(event: NostrEvent): { owner: string; id: string } | null {
    const aTag = event.tags.find(t => t[0] === 'a');
    if (!aTag || !aTag[1]) return null;
    
    const parts = aTag[1].split(':');
    if (parts.length !== 3 || parts[0] !== '30617') return null;
    
    return { owner: parts[1], id: parts[2] };
  }

  /**
   * Fetch issues for a repository
   */
  async getIssues(repoOwnerPubkey: string, repoId: string): Promise<IssueWithStatus[]> {
    const repoAddress = this.getRepoAddress(repoOwnerPubkey, repoId);
    
    const issues = await this.nostrClient.fetchEvents([
      {
        kinds: [KIND.ISSUE],
        '#a': [repoAddress],
        limit: 100
      }
    ]) as Issue[];

    // Fetch status events for each issue
    const issueIds = issues.map(i => i.id);
    const statusEvents = await this.nostrClient.fetchEvents([
      {
        kinds: [KIND.STATUS_OPEN, KIND.STATUS_APPLIED, KIND.STATUS_CLOSED, KIND.STATUS_DRAFT],
        '#e': issueIds,
        limit: 1000
      }
    ]) as StatusEvent[];

    // Group status events by issue ID and get the most recent one
    const statusMap = new Map<string, StatusEvent>();
    for (const status of statusEvents) {
      const rootTag = status.tags.find(t => t[0] === 'e' && t[3] === 'root');
      if (rootTag && rootTag[1]) {
        const issueId = rootTag[1];
        const existing = statusMap.get(issueId);
        if (!existing || status.created_at > existing.created_at) {
          statusMap.set(issueId, status);
        }
      }
    }

    // Combine issues with their status
    return issues.map(issue => {
      const statusEvent = statusMap.get(issue.id);
      let status: 'open' | 'closed' | 'resolved' | 'draft' = 'open';
      
      if (statusEvent) {
        if (statusEvent.kind === KIND.STATUS_OPEN) status = 'open';
        else if (statusEvent.kind === KIND.STATUS_APPLIED) status = 'resolved';
        else if (statusEvent.kind === KIND.STATUS_CLOSED) status = 'closed';
        else if (statusEvent.kind === KIND.STATUS_DRAFT) status = 'draft';
      }

      return {
        ...issue,
        status,
        statusEvent
      };
    });
  }

  /**
   * Create a new issue
   */
  async createIssue(
    repoOwnerPubkey: string,
    repoId: string,
    subject: string,
    content: string,
    labels: string[] = []
  ): Promise<Issue> {
    const repoAddress = this.getRepoAddress(repoOwnerPubkey, repoId);
    
    const tags: string[][] = [
      ['a', repoAddress],
      ['p', repoOwnerPubkey],
      ['subject', subject]
    ];

    // Add labels
    for (const label of labels) {
      tags.push(['t', label]);
    }

    const event = await signEventWithNIP07({
      kind: KIND.ISSUE,
      content,
      tags,
      created_at: Math.floor(Date.now() / 1000),
      pubkey: '' // Will be filled by signer
    });

    const result = await this.nostrClient.publishEvent(event, this.relays);
    if (result.failed.length > 0 && result.success.length === 0) {
      throw new Error('Failed to publish issue to all relays');
    }

    return event as Issue;
  }

  /**
   * Update issue status
   */
  async updateIssueStatus(
    issueId: string,
    issueAuthor: string,
    repoOwnerPubkey: string,
    repoId: string,
    status: 'open' | 'closed' | 'resolved' | 'draft'
  ): Promise<StatusEvent> {
    const repoAddress = this.getRepoAddress(repoOwnerPubkey, repoId);
    
    let kind: number;
    switch (status) {
      case 'open':
        kind = KIND.STATUS_OPEN;
        break;
      case 'resolved':
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
      ['e', issueId, '', 'root'],
      ['p', repoOwnerPubkey],
      ['p', issueAuthor],
      ['a', repoAddress]
    ];

    const event = await signEventWithNIP07({
      kind,
      content: `Issue ${status}`,
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
