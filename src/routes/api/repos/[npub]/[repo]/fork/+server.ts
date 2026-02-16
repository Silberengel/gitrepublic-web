/**
 * API endpoint for forking repositories
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { RepoManager } from '$lib/services/git/repo-manager.js';
import { DEFAULT_NOSTR_RELAYS, combineRelays, getGitUrl } from '$lib/config.js';
import { getUserRelays } from '$lib/services/nostr/user-relays.js';
import { NostrClient } from '$lib/services/nostr/nostr-client.js';
import { KIND } from '$lib/types/nostr.js';
import { nip19 } from 'nostr-tools';
import { signEventWithNIP07 } from '$lib/services/nostr/nip07-signer.js';
import { OwnershipTransferService } from '$lib/services/nostr/ownership-transfer-service.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { join } from 'path';

const execAsync = promisify(exec);
const repoRoot = process.env.GIT_REPO_ROOT || '/repos';
const repoManager = new RepoManager(repoRoot);
const nostrClient = new NostrClient(DEFAULT_NOSTR_RELAYS);

/**
 * POST - Fork a repository
 * Body: { userPubkey, forkName? }
 */
export const POST: RequestHandler = async ({ params, request }) => {
  const { npub, repo } = params;

  if (!npub || !repo) {
    return error(400, 'Missing npub or repo parameter');
  }

  try {
    const body = await request.json();
    const { userPubkey, forkName } = body;

    if (!userPubkey) {
      return error(401, 'Authentication required. Please provide userPubkey.');
    }

    // Decode original repo owner npub
    let originalOwnerPubkey: string;
    try {
      const decoded = nip19.decode(npub);
      if (decoded.type === 'npub') {
        originalOwnerPubkey = decoded.data as string;
      } else {
        return error(400, 'Invalid npub format');
      }
    } catch {
      return error(400, 'Invalid npub format');
    }

    // Decode user pubkey if needed
    let userPubkeyHex = userPubkey;
    try {
      const userDecoded = nip19.decode(userPubkey);
      if (userDecoded.type === 'npub') {
        userPubkeyHex = userDecoded.data as string;
      }
    } catch {
      // Assume it's already hex
    }

    // Check if original repo exists
    const originalRepoPath = join(repoRoot, npub, `${repo}.git`);
    if (!existsSync(originalRepoPath)) {
      return error(404, 'Original repository not found');
    }

    // Get original repo announcement
    const originalAnnouncements = await nostrClient.fetchEvents([
      {
        kinds: [KIND.REPO_ANNOUNCEMENT],
        authors: [originalOwnerPubkey],
        '#d': [repo],
        limit: 1
      }
    ]);

    if (originalAnnouncements.length === 0) {
      return error(404, 'Original repository announcement not found');
    }

    const originalAnnouncement = originalAnnouncements[0];

    // Determine fork name (use original name if not specified)
    const forkRepoName = forkName || repo;
    const userNpub = nip19.npubEncode(userPubkeyHex);

    // Check if fork already exists
    const forkRepoPath = join(repoRoot, userNpub, `${forkRepoName}.git`);
    if (existsSync(forkRepoPath)) {
      return error(409, 'Fork already exists');
    }

    // Clone the repository
    await execAsync(`git clone --bare "${originalRepoPath}" "${forkRepoPath}"`);

    // Create fork announcement
    const gitDomain = process.env.GIT_DOMAIN || 'localhost:6543';
    const protocol = gitDomain.startsWith('localhost') ? 'http' : 'https';
    const forkGitUrl = `${protocol}://${gitDomain}/${userNpub}/${forkRepoName}.git`;

    // Extract original clone URLs and earliest unique commit
    const originalCloneUrls = originalAnnouncement.tags
      .filter(t => t[0] === 'clone')
      .flatMap(t => t.slice(1))
      .filter(url => url && typeof url === 'string') as string[];

    const earliestCommitTag = originalAnnouncement.tags.find(t => t[0] === 'r' && t[2] === 'euc');
    const earliestCommit = earliestCommitTag?.[1];

    // Get original repo name and description
    const originalName = originalAnnouncement.tags.find(t => t[0] === 'name')?.[1] || repo;
    const originalDescription = originalAnnouncement.tags.find(t => t[0] === 'description')?.[1] || '';

    // Build fork announcement tags
    const tags: string[][] = [
      ['d', forkRepoName],
      ['name', `${originalName} (fork)`],
      ['description', `Fork of ${originalName}${originalDescription ? `: ${originalDescription}` : ''}`],
      ['clone', forkGitUrl, ...originalCloneUrls.filter(url => !url.includes(gitDomain))],
      ['relays', ...DEFAULT_NOSTR_RELAYS],
      ['t', 'fork'], // Mark as fork
      ['a', `30617:${originalOwnerPubkey}:${repo}`], // Reference to original repo
      ['p', originalOwnerPubkey], // Original owner
    ];

    // Add earliest unique commit if available
    if (earliestCommit) {
      tags.push(['r', earliestCommit, 'euc']);
    }

    // Create fork announcement event
    const forkAnnouncementTemplate = {
      kind: KIND.REPO_ANNOUNCEMENT,
      pubkey: userPubkeyHex,
      created_at: Math.floor(Date.now() / 1000),
      content: '',
      tags
    };

    // Sign and publish fork announcement
    const signedForkAnnouncement = await signEventWithNIP07(forkAnnouncementTemplate);
    
    const { outbox } = await getUserRelays(userPubkeyHex, nostrClient);
    const combinedRelays = combineRelays(outbox);

    const publishResult = await nostrClient.publishEvent(signedForkAnnouncement, combinedRelays);

    if (publishResult.success.length === 0) {
      // Clean up repo if announcement failed
      await execAsync(`rm -rf "${forkRepoPath}"`).catch(() => {});
      return error(500, 'Failed to publish fork announcement to relays');
    }

    // Create and publish initial ownership proof (self-transfer event)
    const ownershipService = new OwnershipTransferService(combinedRelays);
    const initialOwnershipEvent = ownershipService.createInitialOwnershipEvent(userPubkeyHex, forkRepoName);
    const signedOwnershipEvent = await signEventWithNIP07(initialOwnershipEvent);
    
    await nostrClient.publishEvent(signedOwnershipEvent, combinedRelays).catch(err => {
      console.warn('Failed to publish initial ownership event for fork:', err);
    });

    // Provision the fork repo (this will create verification file and include self-transfer)
    await repoManager.provisionRepo(signedForkAnnouncement, signedOwnershipEvent, false);

    return json({
      success: true,
      fork: {
        npub: userNpub,
        repo: forkRepoName,
        url: forkGitUrl,
        announcementId: signedForkAnnouncement.id
      }
    });
  } catch (err) {
    console.error('Error forking repository:', err);
    return error(500, err instanceof Error ? err.message : 'Failed to fork repository');
  }
};

/**
 * GET - Get fork information
 * Returns whether this is a fork and what it's forked from
 */
export const GET: RequestHandler = async ({ params }) => {
  const { npub, repo } = params;

  if (!npub || !repo) {
    return error(400, 'Missing npub or repo parameter');
  }

  try {
    // Decode repo owner npub
    let ownerPubkey: string;
    try {
      const decoded = nip19.decode(npub);
      if (decoded.type === 'npub') {
        ownerPubkey = decoded.data as string;
      } else {
        return error(400, 'Invalid npub format');
      }
    } catch {
      return error(400, 'Invalid npub format');
    }

    // Get repo announcement
    const announcements = await nostrClient.fetchEvents([
      {
        kinds: [KIND.REPO_ANNOUNCEMENT],
        authors: [ownerPubkey],
        '#d': [repo],
        limit: 1
      }
    ]);

    if (announcements.length === 0) {
      return error(404, 'Repository announcement not found');
    }

    const announcement = announcements[0];
    const isFork = announcement.tags.some(t => t[0] === 't' && t[1] === 'fork');
    
    // Get original repo reference
    const originalRepoTag = announcement.tags.find(t => t[0] === 'a' && t[1]?.startsWith('30617:'));
    const originalOwnerTag = announcement.tags.find(t => t[0] === 'p' && t[1] !== ownerPubkey);

    let originalRepo: { npub: string; repo: string } | null = null;
    if (originalRepoTag && originalRepoTag[1]) {
      const match = originalRepoTag[1].match(/^30617:([a-f0-9]{64}):(.+)$/);
      if (match) {
        const [, originalOwnerPubkey, originalRepoName] = match;
        try {
          const originalNpub = nip19.npubEncode(originalOwnerPubkey);
          originalRepo = { npub: originalNpub, repo: originalRepoName };
        } catch {
          // Invalid pubkey
        }
      }
    }

    return json({
      isFork,
      originalRepo,
      forkCount: 0 // TODO: Count forks of this repo
    });
  } catch (err) {
    console.error('Error getting fork information:', err);
    return error(500, err instanceof Error ? err.message : 'Failed to get fork information');
  }
};
