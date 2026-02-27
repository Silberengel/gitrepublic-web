/**
 * Service for managing Releases (kind 1642)
 * Releases are linked to git tags and provide release notes, changelogs, and binary attachments
 */

import { NostrClient } from './nostr-client.js';
import { KIND } from '../../types/nostr.js';
import type { NostrEvent } from '../../types/nostr.js';
import { signEventWithNIP07 } from './nip07-signer.js';

export interface Release extends NostrEvent {
  kind: typeof KIND.RELEASE;
  title?: string;
  tagName: string;
  tagHash?: string;
  releaseNotes?: string;
  downloadUrl?: string;
  isDraft?: boolean;
  isPrerelease?: boolean;
}

export class ReleasesService {
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
   * Fetch releases for a repository
   */
  async getReleases(repoOwnerPubkey: string, repoId: string): Promise<Release[]> {
    const repoAddress = this.getRepoAddress(repoOwnerPubkey, repoId);
    
    const releases = await this.nostrClient.fetchEvents([
      {
        kinds: [KIND.RELEASE],
        '#a': [repoAddress],
        limit: 100
      }
    ]) as Release[];

    // Parse release information from tags
    return releases.map(release => {
      const title = release.tags.find(t => t[0] === 'title')?.[1];
      const tagName = release.tags.find(t => t[0] === 'tag')?.[1] || '';
      const tagHash = release.tags.find(t => t[0] === 'r' && t[2] === 'tag')?.[1];
      const downloadUrl = release.tags.find(t => t[0] === 'r' && t[2] === 'download')?.[1];
      const isDraft = release.tags.some(t => t[0] === 'draft' && t[1] === 'true');
      const isPrerelease = release.tags.some(t => t[0] === 'prerelease' && t[1] === 'true');

      return {
        ...release,
        title,
        tagName,
        tagHash,
        releaseNotes: release.content,
        downloadUrl,
        isDraft,
        isPrerelease
      };
    });
  }

  /**
   * Get a specific release by tag name
   */
  async getReleaseByTag(repoOwnerPubkey: string, repoId: string, tagName: string): Promise<Release | null> {
    const releases = await this.getReleases(repoOwnerPubkey, repoId);
    return releases.find(r => r.tagName === tagName) || null;
  }

  /**
   * Create a new release
   */
  async createRelease(
    repoOwnerPubkey: string,
    repoId: string,
    title: string,
    tagName: string,
    tagHash: string,
    releaseNotes: string,
    downloadUrl: string,
    isDraft: boolean = false,
    isPrerelease: boolean = false
  ): Promise<Release> {
    const repoAddress = this.getRepoAddress(repoOwnerPubkey, repoId);
    
    const tags: string[][] = [
      ['a', repoAddress],
      ['p', repoOwnerPubkey],
      ['tag', tagName],
      ['r', tagHash, '', 'tag'] // Reference to the git tag commit
    ];

    if (title) {
      tags.push(['title', title]);
    }

    if (downloadUrl) {
      tags.push(['r', downloadUrl, '', 'download']); // Download URL with marker
    }

    if (isDraft) {
      tags.push(['draft', 'true']);
    }

    if (isPrerelease) {
      tags.push(['prerelease', 'true']);
    }

    const event = await signEventWithNIP07({
      kind: KIND.RELEASE,
      content: releaseNotes,
      tags,
      created_at: Math.floor(Date.now() / 1000),
      pubkey: ''
    });

    const result = await this.nostrClient.publishEvent(event, this.relays);
    if (result.failed.length > 0 && result.success.length === 0) {
      throw new Error('Failed to publish release to all relays');
    }

    return {
      ...event as Release,
      tagName,
      tagHash,
      releaseNotes,
      downloadUrl,
      isDraft,
      isPrerelease
    };
  }

  /**
   * Update an existing release (replaceable event)
   * Note: Releases are replaceable events, so updating creates a new event that replaces the old one
   */
  async updateRelease(
    releaseId: string,
    repoOwnerPubkey: string,
    repoId: string,
    tagName: string,
    releaseNotes: string,
    isDraft: boolean = false,
    isPrerelease: boolean = false
  ): Promise<Release> {
    // For replaceable events, we create a new event with the same d-tag
    // The d-tag should be the tag name to make it replaceable
    const repoAddress = this.getRepoAddress(repoOwnerPubkey, repoId);
    
    const tags: string[][] = [
      ['a', repoAddress],
      ['p', repoOwnerPubkey],
      ['d', tagName], // d-tag makes it replaceable
      ['tag', tagName]
    ];

    if (isDraft) {
      tags.push(['draft', 'true']);
    }

    if (isPrerelease) {
      tags.push(['prerelease', 'true']);
    }

    const event = await signEventWithNIP07({
      kind: KIND.RELEASE,
      content: releaseNotes,
      tags,
      created_at: Math.floor(Date.now() / 1000),
      pubkey: ''
    });

    const result = await this.nostrClient.publishEvent(event, this.relays);
    if (result.failed.length > 0 && result.success.length === 0) {
      throw new Error('Failed to publish release update to all relays');
    }

    return {
      ...event as Release,
      tagName,
      releaseNotes,
      isDraft,
      isPrerelease
    };
  }
}
