/**
 * API endpoint for Pull Requests (NIP-34 kind 1618)
 */

import { json, error } from '@sveltejs/kit';
// @ts-ignore - SvelteKit generates this type
import type { RequestHandler } from './$types';
import { PRsService } from '$lib/services/nostr/prs-service.js';
import { DEFAULT_NOSTR_RELAYS } from '$lib/config.js';
import { nip19 } from 'nostr-tools';
import { requireNpubHex } from '$lib/utils/npub-utils.js';
import { handleApiError, handleValidationError, handleNotFoundError, handleAuthorizationError } from '$lib/utils/error-handler.js';

export const GET: RequestHandler = async ({ params, url, request }: { params: { npub?: string; repo?: string }; url: URL; request: Request }) => {
  const { npub, repo } = params;
  const userPubkey = url.searchParams.get('userPubkey') || request.headers.get('x-user-pubkey');

  if (!npub || !repo) {
    return handleValidationError('Missing npub or repo parameter', { operation: 'getPRs' });
  }

  try {
    // Convert npub to pubkey
    let repoOwnerPubkey: string;
    try {
      repoOwnerPubkey = requireNpubHex(npub);
    } catch {
      return handleValidationError('Invalid npub format', { operation: 'getPRs', npub });
    }

    // Check repository privacy
    const { checkRepoAccess } = await import('$lib/utils/repo-privacy.js');
    const access = await checkRepoAccess(npub, repo, userPubkey || null);
    if (!access.allowed) {
      return handleAuthorizationError(access.error || 'Access denied', { operation: 'getPRs', npub, repo });
    }

    const prsService = new PRsService(DEFAULT_NOSTR_RELAYS);
    const prs = await prsService.getPullRequests(repoOwnerPubkey, repo);
    
    return json(prs);
  } catch (err) {
    return handleApiError(err, { operation: 'getPRs', npub, repo }, 'Failed to fetch pull requests');
  }
};

export const POST: RequestHandler = async ({ params, request }: { params: { npub?: string; repo?: string }; request: Request }) => {
  // For creating PRs, we accept a pre-signed event from the client
  const { npub, repo } = params;

  if (!npub || !repo) {
    return handleValidationError('Missing npub or repo parameter', { operation: 'createPR' });
  }

  try {
    const body = await request.json();
    const { event } = body;

    if (!event) {
      return handleValidationError('Missing event in request body', { operation: 'createPR', npub, repo });
    }

    // Verify the event is properly signed
    if (!event.sig || !event.id) {
      return handleValidationError('Invalid event: missing signature or ID', { operation: 'createPR', npub, repo });
    }

    // Publish the event to relays
    const prsService = new PRsService(DEFAULT_NOSTR_RELAYS);
    const result = await prsService['nostrClient'].publishEvent(event, DEFAULT_NOSTR_RELAYS);
    
    if (result.failed.length > 0 && result.success.length === 0) {
      return handleApiError(new Error('Failed to publish pull request to all relays'), { operation: 'createPR', npub, repo }, 'Failed to publish pull request to all relays');
    }

    return json({ success: true, event, published: result });
  } catch (err) {
    return handleApiError(err, { operation: 'createPR', npub, repo }, 'Failed to create pull request');
  }
};
