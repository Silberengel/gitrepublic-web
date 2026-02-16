/**
 * API endpoint for Pull Requests (NIP-34 kind 1618)
 */

import { json, error } from '@sveltejs/kit';
// @ts-ignore - SvelteKit generates this type
import type { RequestHandler } from './$types';
import { PRsService } from '$lib/services/nostr/prs-service.js';
import { DEFAULT_NOSTR_RELAYS } from '$lib/config.js';
import { nip19 } from 'nostr-tools';

export const GET: RequestHandler = async ({ params, url, request }: { params: { npub?: string; repo?: string }; url: URL; request: Request }) => {
  const { npub, repo } = params;
  const userPubkey = url.searchParams.get('userPubkey') || request.headers.get('x-user-pubkey');

  if (!npub || !repo) {
    return error(400, 'Missing npub or repo parameter');
  }

  try {
    // Convert npub to pubkey
    let repoOwnerPubkey: string;
    try {
      const decoded = nip19.decode(npub);
      if (decoded.type === 'npub') {
        repoOwnerPubkey = decoded.data as string;
      } else {
        return error(400, 'Invalid npub format');
      }
    } catch {
      return error(400, 'Invalid npub format');
    }

    // Check repository privacy
    const { checkRepoAccess } = await import('$lib/utils/repo-privacy.js');
    const access = await checkRepoAccess(npub, repo, userPubkey || null);
    if (!access.allowed) {
      return error(403, access.error || 'Access denied');
    }

    const prsService = new PRsService(DEFAULT_NOSTR_RELAYS);
    const prs = await prsService.getPullRequests(repoOwnerPubkey, repo);
    
    return json(prs);
  } catch (err) {
    console.error('Error fetching pull requests:', err);
    return error(500, err instanceof Error ? err.message : 'Failed to fetch pull requests');
  }
};

export const POST: RequestHandler = async ({ params, request }: { params: { npub?: string; repo?: string }; request: Request }) => {
  // For creating PRs, we accept a pre-signed event from the client
  const { npub, repo } = params;

  if (!npub || !repo) {
    return error(400, 'Missing npub or repo parameter');
  }

  try {
    const body = await request.json();
    const { event } = body;

    if (!event) {
      return error(400, 'Missing event in request body');
    }

    // Verify the event is properly signed
    if (!event.sig || !event.id) {
      return error(400, 'Invalid event: missing signature or ID');
    }

    // Publish the event to relays
    const prsService = new PRsService(DEFAULT_NOSTR_RELAYS);
    const result = await prsService['nostrClient'].publishEvent(event, DEFAULT_NOSTR_RELAYS);
    
    if (result.failed.length > 0 && result.success.length === 0) {
      return error(500, 'Failed to publish pull request to all relays');
    }

    return json({ success: true, event, published: result });
  } catch (err) {
    console.error('Error creating pull request:', err);
    return error(500, err instanceof Error ? err.message : 'Failed to create pull request');
  }
};
