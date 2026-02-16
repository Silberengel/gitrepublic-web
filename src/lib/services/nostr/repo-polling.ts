/**
 * Service for polling NIP-34 repo announcements and auto-provisioning repos
 */

import { NostrClient } from './nostr-client.js';
import { KIND } from '../../types/nostr.js';
import type { NostrEvent } from '../../types/nostr.js';
import { RepoManager } from '../git/repo-manager.js';
import { OwnershipTransferService } from './ownership-transfer-service.js';

export class RepoPollingService {
  private nostrClient: NostrClient;
  private repoManager: RepoManager;
  private pollingInterval: number;
  private intervalId: NodeJS.Timeout | null = null;
  private domain: string;
  private relays: string[];

  constructor(
    relays: string[],
    repoRoot: string,
    domain: string,
    pollingInterval: number = 60000 // 1 minute
  ) {
    this.relays = relays;
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
          // Extract repo ID from d-tag
          const dTag = event.tags.find(t => t[0] === 'd')?.[1];
          if (!dTag) {
            console.warn(`Repo announcement ${event.id} missing d-tag`);
            continue;
          }

          // Check if this is an existing repo or new repo
          const cloneUrls = this.extractCloneUrls(event);
          const domainUrl = cloneUrls.find(url => url.includes(this.domain));
          if (!domainUrl) continue;

          const repoPath = this.repoManager.parseRepoUrl(domainUrl);
          if (!repoPath) continue;

          const repoExists = this.repoManager.repoExists(repoPath.fullPath);
          const isExistingRepo = repoExists;

          // Fetch self-transfer event for this repo
          const ownershipService = new OwnershipTransferService(this.relays);
          const repoTag = `30617:${event.pubkey}:${dTag}`;
          
          const selfTransferEvents = await this.nostrClient.fetchEvents([
            {
              kinds: [KIND.OWNERSHIP_TRANSFER],
              '#a': [repoTag],
              authors: [event.pubkey],
              limit: 10
            }
          ]);

          // Find self-transfer event (from owner to themselves)
          let selfTransferEvent: NostrEvent | undefined;
          for (const transferEvent of selfTransferEvents) {
            const pTag = transferEvent.tags.find(t => t[0] === 'p');
            if (pTag && pTag[1] === event.pubkey) {
              // Decode npub if needed
              let toPubkey = pTag[1];
              try {
                const { nip19 } = await import('nostr-tools');
                const decoded = nip19.decode(toPubkey);
                if (decoded.type === 'npub') {
                  toPubkey = decoded.data as string;
                }
              } catch {
                // Assume it's already hex
              }
              
              if (transferEvent.pubkey === event.pubkey && toPubkey === event.pubkey) {
                selfTransferEvent = transferEvent;
                break;
              }
            }
          }

          // For existing repos without self-transfer, create one retroactively
          if (isExistingRepo && !selfTransferEvent) {
            console.log(`Existing repo ${dTag} from ${event.pubkey} has no self-transfer event. Creating template for owner to sign and publish.`);
            
            try {
              // Create a self-transfer event template for the existing repo
              // The owner will need to sign and publish this to relays
              const initialOwnershipEvent = ownershipService.createInitialOwnershipEvent(event.pubkey, dTag);
              
              // Create an unsigned event template that can be included in the repo
              // This serves as a reference and the owner can use it to create the actual event
              const selfTransferTemplate = {
                ...initialOwnershipEvent,
                id: '', // Will be computed when signed
                sig: '', // Needs owner signature
                _note: 'This is a template. The owner must sign and publish this event to relays for it to be valid.'
              } as NostrEvent & { _note?: string };
              
              // Use the template (even though it's unsigned, it will be included in the repo)
              selfTransferEvent = selfTransferTemplate;
              
              console.warn(`Self-transfer event template created for ${dTag}. Owner ${event.pubkey} should sign and publish it to relays.`);
            } catch (err) {
              console.error(`Failed to create self-transfer event template for ${dTag}:`, err);
            }
          }

          // Provision the repo with self-transfer event if available
          await this.repoManager.provisionRepo(event, selfTransferEvent, isExistingRepo);
          console.log(`Provisioned repo from announcement ${event.id}${isExistingRepo ? ' (existing)' : ' (new)'}`);
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
