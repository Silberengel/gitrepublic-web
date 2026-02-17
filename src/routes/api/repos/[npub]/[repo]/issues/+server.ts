/**
 * API endpoint for Issues (NIP-34 kind 1621)
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { issuesService, nostrClient } from '$lib/services/service-registry.js';
import { createRepoGetHandler, withRepoValidation } from '$lib/utils/api-handlers.js';
import type { RepoRequestContext, RequestEvent } from '$lib/utils/api-context.js';
import { handleValidationError, handleApiError } from '$lib/utils/error-handler.js';
import { DEFAULT_NOSTR_RELAYS } from '$lib/config.js';

export const GET: RequestHandler = createRepoGetHandler(
  async (context: RepoRequestContext) => {
    const issues = await issuesService.getIssues(context.repoOwnerPubkey, context.repo);
    return json(issues);
  },
  { operation: 'getIssues', requireRepoExists: false, requireRepoAccess: false } // Issues are stored in Nostr, don't require local repo
);

export const POST: RequestHandler = withRepoValidation(
  async ({ repoContext, requestContext, event }) => {
    const body = await event.request.json();
    const { event: issueEvent } = body;

    if (!issueEvent) {
      throw handleValidationError('Missing event in request body', { operation: 'createIssue', npub: repoContext.npub, repo: repoContext.repo });
    }

    // Verify the event is properly signed (basic check)
    if (!issueEvent.sig || !issueEvent.id) {
      throw handleValidationError('Invalid event: missing signature or ID', { operation: 'createIssue', npub: repoContext.npub, repo: repoContext.repo });
    }

    // Publish the event to relays
    const result = await nostrClient.publishEvent(issueEvent, DEFAULT_NOSTR_RELAYS);
    
    if (result.failed.length > 0 && result.success.length === 0) {
      throw handleApiError(new Error('Failed to publish issue to all relays'), { operation: 'createIssue', npub: repoContext.npub, repo: repoContext.repo }, 'Failed to publish issue to all relays');
    }

    return json({ success: true, event: issueEvent, published: result });
  },
  { operation: 'createIssue', requireRepoAccess: false } // Issues can be created by anyone with access
);
