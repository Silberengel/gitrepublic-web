/**
 * API endpoint for branch protection rules
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { branchProtectionService, ownershipTransferService, nostrClient } from '$lib/services/service-registry.js';
import { combineRelays } from '$lib/config.js';
import { getUserRelays } from '$lib/services/nostr/user-relays.js';
import { signEventWithNIP07 } from '$lib/services/nostr/nip07-signer.js';
import type { BranchProtectionRule } from '$lib/services/nostr/branch-protection-service.js';
import { createRepoGetHandler, createRepoPostHandler } from '$lib/utils/api-handlers.js';
import type { RepoRequestContext, RequestEvent } from '$lib/utils/api-context.js';
import { handleApiError, handleValidationError, handleAuthorizationError } from '$lib/utils/error-handler.js';

/**
 * GET - Get branch protection rules
 */
export const GET: RequestHandler = createRepoGetHandler(
  async (context: RepoRequestContext) => {
    const config = await branchProtectionService.getBranchProtection(context.repoOwnerPubkey, context.repo);
    
    if (!config) {
      return json({ rules: [] });
    }

    return json(config);
  },
  { operation: 'getBranchProtection', requireRepoAccess: false } // Branch protection rules are public
);

/**
 * POST - Update branch protection rules
 */
export const POST: RequestHandler = createRepoPostHandler(
  async (context: RepoRequestContext, event: RequestEvent) => {
    const body = await event.request.json();
    const { rules } = body;

    if (!Array.isArray(rules)) {
      return handleValidationError('Rules must be an array', { operation: 'updateBranchProtection', npub: context.npub, repo: context.repo });
    }

    // Check if user is owner
    const currentOwner = await ownershipTransferService.getCurrentOwner(context.repoOwnerPubkey, context.repo);
    if (context.userPubkeyHex !== currentOwner) {
      return handleAuthorizationError('Only the repository owner can update branch protection', { operation: 'updateBranchProtection', npub: context.npub, repo: context.repo });
    }

    // Validate rules
    const validatedRules: BranchProtectionRule[] = rules.map((rule: { branch: string; requirePullRequest?: boolean; requireReviewers?: string[]; allowForcePush?: boolean; requireStatusChecks?: string[]; allowedMaintainers?: string[] }) => ({
      branch: rule.branch,
      requirePullRequest: rule.requirePullRequest || false,
      requireReviewers: rule.requireReviewers || [],
      allowForcePush: rule.allowForcePush || false,
      requireStatusChecks: rule.requireStatusChecks || [],
      allowedMaintainers: rule.allowedMaintainers || []
    }));

    // Create protection event
    const protectionEvent = branchProtectionService.createProtectionEvent(
      currentOwner,
      context.repo,
      validatedRules
    );

    // Sign and publish
    const signedEvent = await signEventWithNIP07(protectionEvent);
    
    const { outbox } = await getUserRelays(currentOwner, nostrClient);
    const combinedRelays = combineRelays(outbox);

    const result = await nostrClient.publishEvent(signedEvent, combinedRelays);

    if (result.success.length === 0) {
      throw handleApiError(new Error('Failed to publish branch protection rules to relays'), { operation: 'updateBranchProtection', npub: context.npub, repo: context.repo }, 'Failed to publish branch protection rules to relays');
    }

    return json({ success: true, event: signedEvent, rules: validatedRules });
  },
  { operation: 'updateBranchProtection', requireMaintainer: false } // Override to check owner instead
);
