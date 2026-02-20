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
import { MaintainerService } from '$lib/services/nostr/maintainer-service.js';
import { forwardEventIfEnabled } from '$lib/services/messaging/event-forwarder.js';
import logger from '$lib/services/logger.js';

const maintainerService = new MaintainerService(DEFAULT_NOSTR_RELAYS);

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

    // Forward to messaging platforms if user has unlimited access and preferences configured
    if (requestContext.userPubkeyHex && result.success.length > 0) {
      forwardEventIfEnabled(issueEvent, requestContext.userPubkeyHex)
        .catch(err => {
          // Log but don't fail the request - forwarding is optional
          logger.warn({ error: err, npub: repoContext.npub, repo: repoContext.repo }, 'Failed to forward event to messaging platforms');
        });
    }

    return json({ success: true, event: issueEvent, published: result });
  },
  { operation: 'createIssue', requireRepoAccess: false } // Issues can be created by anyone with access
);

export const PATCH: RequestHandler = withRepoValidation(
  async ({ repoContext, requestContext, event }) => {
    const body = await event.request.json();
    const { issueId, issueAuthor, status } = body;

    if (!issueId || !issueAuthor || !status) {
      throw handleValidationError('Missing required fields: issueId, issueAuthor, status', { operation: 'updateIssueStatus', npub: repoContext.npub, repo: repoContext.repo });
    }

    // Check if user is maintainer or issue author
    const { IssuesService } = await import('$lib/services/nostr/issues-service.js');
    const issuesService = new IssuesService(DEFAULT_NOSTR_RELAYS);
    const isMaintainer = await maintainerService.isMaintainer(requestContext.userPubkeyHex || '', repoContext.repoOwnerPubkey, repoContext.repo);
    const isAuthor = requestContext.userPubkeyHex === issueAuthor;
    
    if (!isMaintainer && !isAuthor && requestContext.userPubkeyHex !== repoContext.repoOwnerPubkey) {
      throw handleApiError(new Error('Only repository owners, maintainers, or issue authors can update issue status'), { operation: 'updateIssueStatus', npub: repoContext.npub, repo: repoContext.repo }, 'Unauthorized');
    }

    // Update issue status
    const statusEvent = await issuesService.updateIssueStatus(
      issueId,
      issueAuthor,
      repoContext.repoOwnerPubkey,
      repoContext.repo,
      status
    );

    return json({ success: true, event: statusEvent });
  },
  { operation: 'updateIssueStatus', requireRepoAccess: false }
);
