/**
 * API endpoint for forking repositories
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { RepoManager } from '$lib/services/git/repo-manager.js';
import { DEFAULT_NOSTR_RELAYS, combineRelays, getGitUrl } from '$lib/config.js';
import { getUserRelays } from '$lib/services/nostr/user-relays.js';
import { NostrClient } from '$lib/services/nostr/nostr-client.js';
import { KIND, type NostrEvent } from '$lib/types/nostr.js';
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
 * Retry publishing an event with exponential backoff
 * Attempts up to 3 times with delays: 1s, 2s, 4s
 */
async function publishEventWithRetry(
  event: NostrEvent,
  relays: string[],
  eventName: string,
  maxAttempts: number = 3
): Promise<{ success: string[]; failed: Array<{ relay: string; error: string }> }> {
  let lastResult: { success: string[]; failed: Array<{ relay: string; error: string }> } | null = null;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`[Fork] Publishing ${eventName} - Attempt ${attempt}/${maxAttempts}...`);
    
    lastResult = await nostrClient.publishEvent(event, relays);
    
    if (lastResult.success.length > 0) {
      console.log(`[Fork] ✓ ${eventName} published successfully to ${lastResult.success.length} relay(s): ${lastResult.success.join(', ')}`);
      if (lastResult.failed.length > 0) {
        console.warn(`[Fork] ⚠ Some relays failed: ${lastResult.failed.map(f => `${f.relay}: ${f.error}`).join(', ')}`);
      }
      return lastResult;
    }
    
    if (attempt < maxAttempts) {
      const delayMs = Math.pow(2, attempt - 1) * 1000; // 1s, 2s, 4s
      console.warn(`[Fork] ✗ ${eventName} failed on attempt ${attempt}. Retrying in ${delayMs}ms...`);
      console.warn(`[Fork] Failed relays: ${lastResult.failed.map(f => `${f.relay}: ${f.error}`).join(', ')}`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  
  // All attempts failed
  console.error(`[Fork] ✗ ${eventName} failed after ${maxAttempts} attempts`);
  console.error(`[Fork] All relay failures: ${lastResult?.failed.map(f => `${f.relay}: ${f.error}`).join(', ')}`);
  return lastResult!;
}

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
      const userDecoded = nip19.decode(userPubkey) as { type: string; data: unknown };
      // Type guard: check if it's an npub
      if (userDecoded.type === 'npub' && typeof userDecoded.data === 'string') {
        userPubkeyHex = userDecoded.data;
      }
      // If not npub, assume it's already hex
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

    console.log(`[Fork] Starting fork process for ${forkRepoName} by ${userNpub}`);
    console.log(`[Fork] Using ${combinedRelays.length} relay(s): ${combinedRelays.join(', ')}`);

    const publishResult = await publishEventWithRetry(
      signedForkAnnouncement,
      combinedRelays,
      'fork announcement',
      3
    );

    if (publishResult.success.length === 0) {
      // Clean up repo if announcement failed
      console.error(`[Fork] ✗ Fork announcement failed after all retries. Cleaning up repository.`);
      await execAsync(`rm -rf "${forkRepoPath}"`).catch(() => {});
      const errorDetails = `All relays failed: ${publishResult.failed.map(f => `${f.relay}: ${f.error}`).join('; ')}`;
      return json({
        success: false,
        error: 'Failed to publish fork announcement to relays after 3 attempts',
        details: errorDetails,
        eventName: 'fork announcement'
      }, { status: 500 });
    }

    // Create and publish initial ownership proof (self-transfer event)
    // This MUST succeed for the fork to be valid - without it, there's no proof of ownership on Nostr
    const ownershipService = new OwnershipTransferService(combinedRelays);
    const initialOwnershipEvent = ownershipService.createInitialOwnershipEvent(userPubkeyHex, forkRepoName);
    const signedOwnershipEvent = await signEventWithNIP07(initialOwnershipEvent);
    
    const ownershipPublishResult = await publishEventWithRetry(
      signedOwnershipEvent,
      combinedRelays,
      'ownership transfer event',
      3
    );

    if (ownershipPublishResult.success.length === 0) {
      // Clean up repo if ownership proof failed
      console.error(`[Fork] ✗ Ownership transfer event failed after all retries. Cleaning up repository and publishing deletion request.`);
      await execAsync(`rm -rf "${forkRepoPath}"`).catch(() => {});
      
      // Publish deletion request (NIP-09) for the announcement since it's invalid without ownership proof
      console.log(`[Fork] Publishing deletion request for invalid fork announcement...`);
      const deletionRequest = {
        kind: 5, // NIP-09: Event Deletion Request
        pubkey: userPubkeyHex,
        created_at: Math.floor(Date.now() / 1000),
        content: 'Fork failed: ownership transfer event could not be published after 3 attempts. This announcement is invalid.',
        tags: [
          ['a', `30617:${userPubkeyHex}:${forkRepoName}`], // Reference to the repo announcement
          ['k', KIND.REPO_ANNOUNCEMENT.toString()] // Kind of event being deleted
        ]
      };
      
      const signedDeletionRequest = await signEventWithNIP07(deletionRequest);
      const deletionResult = await publishEventWithRetry(
        signedDeletionRequest,
        combinedRelays,
        'deletion request',
        3
      );
      
      if (deletionResult.success.length > 0) {
        console.log(`[Fork] ✓ Deletion request published successfully`);
      } else {
        console.error(`[Fork] ✗ Failed to publish deletion request: ${deletionResult.failed.map(f => `${f.relay}: ${f.error}`).join(', ')}`);
      }
      
      const errorDetails = `Fork is invalid without ownership proof. All relays failed: ${ownershipPublishResult.failed.map(f => `${f.relay}: ${f.error}`).join('; ')}. Deletion request ${deletionResult.success.length > 0 ? 'published' : 'failed to publish'}.`;
      return json({
        success: false,
        error: 'Failed to publish ownership transfer event to relays after 3 attempts',
        details: errorDetails,
        eventName: 'ownership transfer event'
      }, { status: 500 });
    }

    // Provision the fork repo (this will create verification file and include self-transfer)
    console.log(`[Fork] Provisioning fork repository...`);
    await repoManager.provisionRepo(signedForkAnnouncement, signedOwnershipEvent, false);

    console.log(`[Fork] ✓ Fork completed successfully!`);
    console.log(`[Fork]   - Repository: ${userNpub}/${forkRepoName}`);
    console.log(`[Fork]   - Announcement ID: ${signedForkAnnouncement.id}`);
    console.log(`[Fork]   - Ownership transfer ID: ${signedOwnershipEvent.id}`);
    console.log(`[Fork]   - Published to ${publishResult.success.length} relay(s) for announcement`);
    console.log(`[Fork]   - Published to ${ownershipPublishResult.success.length} relay(s) for ownership transfer`);

    return json({
      success: true,
      fork: {
        npub: userNpub,
        repo: forkRepoName,
        url: forkGitUrl,
        announcementId: signedForkAnnouncement.id,
        ownershipTransferId: signedOwnershipEvent.id,
        publishedTo: {
          announcement: publishResult.success.length,
          ownershipTransfer: ownershipPublishResult.success.length
        }
      },
      message: `Repository forked successfully! Published to ${publishResult.success.length} relay(s) for announcement and ${ownershipPublishResult.success.length} relay(s) for ownership proof.`
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
