/**
 * Service for polling NIP-34 repo announcements and auto-provisioning repos
 */

import { NostrClient } from './nostr-client.js';
import { KIND } from '../../types/nostr.js';
import type { NostrEvent } from '../../types/nostr.js';
import { RepoManager } from '../git/repo-manager.js';

export class RepoPollingService {
  private nostrClient: NostrClient;
  private repoManager: RepoManager;
  private pollingInterval: number;
  private intervalId: NodeJS.Timeout | null = null;
  private domain: string;

  constructor(
    relays: string[],
    repoRoot: string,
    domain: string,
    pollingInterval: number = 60000 // 1 minute
  ) {
    this.nostrClient = new NostrClient(relays);
    this.repoManager = new RepoManager(repoRoot, domain);
    this.pollingInterval = pollingInterval;
    this.domain = domain;
  }

  /**
   * Start polling for repo announcements
   */
  start(): void {
    if (this.intervalId) {
      this.stop();
    }

    // Poll immediately
    this.poll();

    // Then poll at intervals
    this.intervalId = setInterval(() => {
      this.poll();
    }, this.pollingInterval);
  }

  /**
   * Stop polling
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Poll for new repo announcements and provision repos
   */
  private async poll(): Promise<void> {
    try {
      const events = await this.nostrClient.fetchEvents([
        {
          kinds: [KIND.REPO_ANNOUNCEMENT],
          limit: 100
        }
      ]);

      // Filter for repos that list our domain
      const relevantEvents = events.filter(event => {
        const cloneUrls = this.extractCloneUrls(event);
        return cloneUrls.some(url => url.includes(this.domain));
      });

      // Provision each repo
      for (const event of relevantEvents) {
        try {
          await this.repoManager.provisionRepo(event);
          console.log(`Provisioned repo from announcement ${event.id}`);
        } catch (error) {
          console.error(`Failed to provision repo from ${event.id}:`, error);
        }
      }
    } catch (error) {
      console.error('Error polling for repo announcements:', error);
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
}
