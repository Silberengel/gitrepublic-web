/**
 * API endpoint for Releases (kind 1642)
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { releasesService, nostrClient } from '$lib/services/service-registry.js';
import { createRepoGetHandler, withRepoValidation } from '$lib/utils/api-handlers.js';
import type { RepoRequestContext, RequestEvent } from '$lib/utils/api-context.js';
import { handleValidationError, handleApiError } from '$lib/utils/error-handler.js';
import { DEFAULT_NOSTR_RELAYS } from '$lib/config.js';
import { MaintainerService } from '$lib/services/nostr/maintainer-service.js';
import { forwardEventIfEnabled } from '$lib/services/messaging/event-forwarder.js';
import logger from '$lib/services/logger.js';

export const GET: RequestHandler = createRepoGetHandler(
  async (context: RepoRequestContext) => {
    const releases = await releasesService.getReleases(context.repoOwnerPubkey, context.repo);
    return json(releases);
  },
  { operation: 'getReleases', requireRepoExists: false, requireRepoAccess: false } // Releases are stored in Nostr
);

export const POST: RequestHandler = withRepoValidation(
  async ({ repoContext, requestContext, event }) => {
    const body = await event.request.json();
    const { title, tagName, tagHash, releaseNotes, downloadUrl, isDraft, isPrerelease } = body;

    if (!tagName || !tagHash) {
      throw handleValidationError('Missing required fields: tagName, tagHash', { operation: 'createRelease', npub: repoContext.npub, repo: repoContext.repo });
    }

    // Check if user is maintainer or owner
    const maintainerService = new MaintainerService(DEFAULT_NOSTR_RELAYS);
    const isMaintainer = await maintainerService.isMaintainer(requestContext.userPubkeyHex || '', repoContext.repoOwnerPubkey, repoContext.repo);
    
    if (!isMaintainer && requestContext.userPubkeyHex !== repoContext.repoOwnerPubkey) {
      throw handleApiError(new Error('Only repository owners and maintainers can create releases'), { operation: 'createRelease', npub: repoContext.npub, repo: repoContext.repo }, 'Unauthorized');
    }

    // Create release
    const release = await releasesService.createRelease(
      repoContext.repoOwnerPubkey,
      repoContext.repo,
      title || '',
      tagName,
      tagHash,
      releaseNotes || '',
      downloadUrl || '',
      isDraft || false,
      isPrerelease || false
    );

    // Forward to messaging platforms if user has unlimited access and preferences configured
    if (requestContext.userPubkeyHex) {
      forwardEventIfEnabled(release, requestContext.userPubkeyHex)
        .catch(err => {
          // Log but don't fail the request - forwarding is optional
          logger.warn({ error: err, npub: repoContext.npub, repo: repoContext.repo }, 'Failed to forward event to messaging platforms');
        });
    }

    return json({ success: true, event: release });
  },
  { operation: 'createRelease', requireRepoAccess: false }
);

export const PATCH: RequestHandler = withRepoValidation(
  async ({ repoContext, requestContext, event }) => {
    const body = await event.request.json();
    const { releaseId, tagName, releaseNotes, isDraft, isPrerelease } = body;

    if (!releaseId || !tagName) {
      throw handleValidationError('Missing required fields: releaseId, tagName', { operation: 'updateRelease', npub: repoContext.npub, repo: repoContext.repo });
    }

    // Check if user is maintainer or owner
    const maintainerService = new MaintainerService(DEFAULT_NOSTR_RELAYS);
    const isMaintainer = await maintainerService.isMaintainer(requestContext.userPubkeyHex || '', repoContext.repoOwnerPubkey, repoContext.repo);
    
    if (!isMaintainer && requestContext.userPubkeyHex !== repoContext.repoOwnerPubkey) {
      throw handleApiError(new Error('Only repository owners and maintainers can update releases'), { operation: 'updateRelease', npub: repoContext.npub, repo: repoContext.repo }, 'Unauthorized');
    }

    // Update release
    const release = await releasesService.updateRelease(
      releaseId,
      repoContext.repoOwnerPubkey,
      repoContext.repo,
      tagName,
      releaseNotes || '',
      isDraft || false,
      isPrerelease || false
    );

    return json({ success: true, event: release });
  },
  { operation: 'updateRelease', requireRepoAccess: false }
);
