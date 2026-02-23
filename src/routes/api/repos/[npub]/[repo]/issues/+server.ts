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
import { forwardEventIfEnabled } from '$lib/services/messaging/event-forwarder.js';
import logger from '$lib/services/logger.js';
import { maintainerService } from '$lib/services/service-registry.js';
import { KIND, type NostrEvent } from '$lib/types/nostr.js';
import { verifyEvent } from 'nostr-tools';
import { validatePubkey } from '$lib/utils/input-validation.js';

export const GET: RequestHandler = createRepoGetHandler(
  async (context: RepoRequestContext) => {
    const issues = await issuesService.getIssues(context.repoOwnerPubkey, context.repo);
    return json(issues);
  },
  { operation: 'getIssues', requireRepoExists: false, requireRepoAccess: false } // Issues are stored in Nostr, don't require local repo
);

/**
 * Validate issue event structure
 */
function validateIssueEvent(event: any, repoOwnerPubkey: string, repoName: string): event is NostrEvent {
  if (!event || typeof event !== 'object') {
    return false;
  }

  // Check required fields
  if (!event.kind || event.kind !== KIND.ISSUE) {
    return false;
  }

  if (!event.pubkey || typeof event.pubkey !== 'string') {
    return false;
  }

  // Validate pubkey format
  const pubkeyValidation = validatePubkey(event.pubkey);
  if (!pubkeyValidation.valid) {
    return false;
  }

  if (!event.id || typeof event.id !== 'string' || event.id.length !== 64) {
    return false;
  }

  if (!event.sig || typeof event.sig !== 'string' || event.sig.length !== 128) {
    return false;
  }

  if (typeof event.created_at !== 'number' || event.created_at <= 0) {
    return false;
  }

  // Validate tags structure
  if (!Array.isArray(event.tags)) {
    return false;
  }

  // Validate content is a string
  if (typeof event.content !== 'string') {
    return false;
  }

  // Verify event signature
  if (!verifyEvent(event as NostrEvent)) {
    return false;
  }

  return true;
}

export const POST: RequestHandler = withRepoValidation(
  async ({ repoContext, requestContext, event }) => {
    const body = await event.request.json();
    const { event: issueEvent } = body;

    if (!issueEvent) {
      throw handleValidationError('Missing event in request body', { operation: 'createIssue', npub: repoContext.npub, repo: repoContext.repo });
    }

    // Validate event structure and signature
    if (!validateIssueEvent(issueEvent, repoContext.repoOwnerPubkey, repoContext.repo)) {
      throw handleValidationError('Invalid event: missing required fields, invalid format, or invalid signature', { operation: 'createIssue', npub: repoContext.npub, repo: repoContext.repo });
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

/**
 * Validate issue status update request
 */
type StatusUpdateValidation =
  | { valid: true; issueId: string; issueAuthor: string; status: 'open' | 'closed' | 'resolved' | 'draft' }
  | { valid: false; error: string };

function validateStatusUpdate(body: any): StatusUpdateValidation {
  if (!body || typeof body !== 'object') {
    return { valid: false, error: 'Invalid request body' };
  }

  const { issueId, issueAuthor, status } = body;

  if (!issueId || typeof issueId !== 'string' || issueId.length !== 64) {
    return { valid: false, error: 'Invalid issueId: must be a 64-character hex string' };
  }

  if (!issueAuthor || typeof issueAuthor !== 'string') {
    return { valid: false, error: 'Invalid issueAuthor: must be a string' };
  }

  // Validate pubkey format
  const pubkeyValidation = validatePubkey(issueAuthor);
  if (!pubkeyValidation.valid) {
    return { valid: false, error: `Invalid issueAuthor: ${pubkeyValidation.error}` };
  }

  if (!status || typeof status !== 'string') {
    return { valid: false, error: 'Invalid status: must be a string' };
  }

  // Validate status value - must match the service's expected types
  const validStatuses: ('open' | 'closed' | 'resolved' | 'draft')[] = ['open', 'closed', 'resolved', 'draft'];
  const normalizedStatus = status.toLowerCase() as 'open' | 'closed' | 'resolved' | 'draft';
  if (!validStatuses.includes(normalizedStatus)) {
    return { valid: false, error: `Invalid status: must be one of ${validStatuses.join(', ')}` };
  }

  return { valid: true, issueId, issueAuthor, status: normalizedStatus };
}

export const PATCH: RequestHandler = withRepoValidation(
  async ({ repoContext, requestContext, event }) => {
    const body = await event.request.json();
    
    // Validate request body
    const validation = validateStatusUpdate(body);
    if (!validation.valid) {
      throw handleValidationError(validation.error || 'Invalid request', { operation: 'updateIssueStatus', npub: repoContext.npub, repo: repoContext.repo });
    }

    const { issueId, issueAuthor, status } = validation;

    // Check if user is maintainer or issue author
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
