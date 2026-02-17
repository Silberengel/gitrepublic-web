/**
 * API endpoint for Issues (NIP-34 kind 1621)
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { IssuesService } from '$lib/services/nostr/issues-service.js';
import { DEFAULT_NOSTR_RELAYS } from '$lib/config.js';
import { nip19 } from 'nostr-tools';
import logger from '$lib/services/logger.js';

export const GET: RequestHandler = async ({ params, url, request }) => {
  const { npub, repo } = params;
  const userPubkey = url.searchParams.get('userPubkey') || request.headers.get('x-user-pubkey');

  if (!npub || !repo) {
    return error(400, 'Missing npub or repo parameter');
  }

  try {
    // Convert npub to pubkey
    let repoOwnerPubkey: string;
    try {
      repoOwnerPubkey = requireNpubHex(npub);
    } catch {
      return error(400, 'Invalid npub format');
    }

    // Check repository privacy
    const { checkRepoAccess } = await import('$lib/utils/repo-privacy.js');
    const access = await checkRepoAccess(npub, repo, userPubkey || null);
    if (!access.allowed) {
      return error(403, access.error || 'Access denied');
    }

    const issuesService = new IssuesService(DEFAULT_NOSTR_RELAYS);
    const issues = await issuesService.getIssues(repoOwnerPubkey, repo);
    
    return json(issues);
  } catch (err) {
    logger.error({ error: err, npub, repo }, 'Error fetching issues');
    return error(500, err instanceof Error ? err.message : 'Failed to fetch issues');
  }
};

export const POST: RequestHandler = async ({ params, request }) => {
  // For creating issues, we accept a pre-signed event from the client
  // since NIP-07 signing must happen client-side
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

    // Verify the event is properly signed (basic check)
    if (!event.sig || !event.id) {
      return error(400, 'Invalid event: missing signature or ID');
    }

    // Publish the event to relays
    const issuesService = new IssuesService(DEFAULT_NOSTR_RELAYS);
    const result = await issuesService['nostrClient'].publishEvent(event, DEFAULT_NOSTR_RELAYS);
    
    if (result.failed.length > 0 && result.success.length === 0) {
      return error(500, 'Failed to publish issue to all relays');
    }

    return json({ success: true, event, published: result });
  } catch (err) {
    logger.error({ error: err, npub, repo }, 'Error creating issue');
    return error(500, err instanceof Error ? err.message : 'Failed to create issue');
  }
};
