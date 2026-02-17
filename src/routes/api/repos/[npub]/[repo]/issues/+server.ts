/**
 * API endpoint for Issues (NIP-34 kind 1621)
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { IssuesService } from '$lib/services/nostr/issues-service.js';
import { DEFAULT_NOSTR_RELAYS } from '$lib/config.js';
import { nip19 } from 'nostr-tools';
import { requireNpubHex } from '$lib/utils/npub-utils.js';
import { handleApiError, handleValidationError, handleNotFoundError, handleAuthorizationError } from '$lib/utils/error-handler.js';

export const GET: RequestHandler = async ({ params, url, request }) => {
  const { npub, repo } = params;
  const userPubkey = url.searchParams.get('userPubkey') || request.headers.get('x-user-pubkey');

  if (!npub || !repo) {
    return handleValidationError('Missing npub or repo parameter', { operation: 'getIssues' });
  }

  try {
    // Convert npub to pubkey
    let repoOwnerPubkey: string;
    try {
      repoOwnerPubkey = requireNpubHex(npub);
    } catch {
      return handleValidationError('Invalid npub format', { operation: 'getIssues', npub });
    }

    // Check repository privacy
    const { checkRepoAccess } = await import('$lib/utils/repo-privacy.js');
    const access = await checkRepoAccess(npub, repo, userPubkey || null);
    if (!access.allowed) {
      return handleAuthorizationError(access.error || 'Access denied', { operation: 'getIssues', npub, repo });
    }

    const issuesService = new IssuesService(DEFAULT_NOSTR_RELAYS);
    const issues = await issuesService.getIssues(repoOwnerPubkey, repo);
    
    return json(issues);
  } catch (err) {
    return handleApiError(err, { operation: 'getIssues', npub, repo }, 'Failed to fetch issues');
  }
};

export const POST: RequestHandler = async ({ params, request }) => {
  // For creating issues, we accept a pre-signed event from the client
  // since NIP-07 signing must happen client-side
  const { npub, repo } = params;

  if (!npub || !repo) {
    return handleValidationError('Missing npub or repo parameter', { operation: 'createIssue' });
  }

  try {
    const body = await request.json();
    const { event } = body;

    if (!event) {
      return handleValidationError('Missing event in request body', { operation: 'createIssue', npub, repo });
    }

    // Verify the event is properly signed (basic check)
    if (!event.sig || !event.id) {
      return handleValidationError('Invalid event: missing signature or ID', { operation: 'createIssue', npub, repo });
    }

    // Publish the event to relays
    const issuesService = new IssuesService(DEFAULT_NOSTR_RELAYS);
    const result = await issuesService['nostrClient'].publishEvent(event, DEFAULT_NOSTR_RELAYS);
    
    if (result.failed.length > 0 && result.success.length === 0) {
      return handleApiError(new Error('Failed to publish issue to all relays'), { operation: 'createIssue', npub, repo }, 'Failed to publish issue to all relays');
    }

    return json({ success: true, event, published: result });
  } catch (err) {
    return handleApiError(err, { operation: 'createIssue', npub, repo }, 'Failed to create issue');
  }
};
