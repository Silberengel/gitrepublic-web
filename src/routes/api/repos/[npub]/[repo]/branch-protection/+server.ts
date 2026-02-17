/**
 * API endpoint for branch protection rules
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { BranchProtectionService } from '$lib/services/nostr/branch-protection-service.js';
import { DEFAULT_NOSTR_RELAYS, combineRelays } from '$lib/config.js';
import { getUserRelays } from '$lib/services/nostr/user-relays.js';
import { OwnershipTransferService } from '$lib/services/nostr/ownership-transfer-service.js';
import { signEventWithNIP07 } from '$lib/services/nostr/nip07-signer.js';
import { NostrClient } from '$lib/services/nostr/nostr-client.js';
import { nip19 } from 'nostr-tools';
import type { BranchProtectionRule } from '$lib/services/nostr/branch-protection-service.js';
import { requireNpubHex, decodeNpubToHex } from '$lib/utils/npub-utils.js';
import { handleApiError, handleValidationError, handleAuthError, handleAuthorizationError } from '$lib/utils/error-handler.js';

const branchProtectionService = new BranchProtectionService(DEFAULT_NOSTR_RELAYS);
const ownershipTransferService = new OwnershipTransferService(DEFAULT_NOSTR_RELAYS);
const nostrClient = new NostrClient(DEFAULT_NOSTR_RELAYS);

/**
 * GET - Get branch protection rules
 */
export const GET: RequestHandler = async ({ params }: { params: { npub?: string; repo?: string } }) => {
  const { npub, repo } = params;

  if (!npub || !repo) {
    return handleValidationError('Missing npub or repo parameter', { operation: 'getBranchProtection' });
  }

  try {
    // Decode npub to get pubkey
    let ownerPubkey: string;
    try {
      ownerPubkey = requireNpubHex(npub);
    } catch {
      return handleValidationError('Invalid npub format', { operation: 'getBranchProtection', npub });
    }

    const config = await branchProtectionService.getBranchProtection(ownerPubkey, repo);
    
    if (!config) {
      return json({ rules: [] });
    }

    return json(config);
  } catch (err) {
    return handleApiError(err, { operation: 'getBranchProtection', npub, repo }, 'Failed to get branch protection');
  }
};

/**
 * POST - Update branch protection rules
 */
export const POST: RequestHandler = async ({ params, request }: { params: { npub?: string; repo?: string }; request: Request }) => {
  const { npub, repo } = params;

  if (!npub || !repo) {
    return handleValidationError('Missing npub or repo parameter', { operation: 'updateBranchProtection' });
  }

  try {
    const body = await request.json();
    const { userPubkey, rules } = body;

    if (!userPubkey) {
      return handleAuthError('Authentication required', { operation: 'updateBranchProtection', npub, repo });
    }

    if (!Array.isArray(rules)) {
      return handleValidationError('Rules must be an array', { operation: 'updateBranchProtection', npub, repo });
    }

    // Decode npub to get pubkey
    let ownerPubkey: string;
    try {
      ownerPubkey = requireNpubHex(npub);
    } catch {
      return handleValidationError('Invalid npub format', { operation: 'updateBranchProtection', npub });
    }

    const userPubkeyHex = decodeNpubToHex(userPubkey) || userPubkey;

    // Check if user is owner
    const currentOwner = await ownershipTransferService.getCurrentOwner(ownerPubkey, repo);
    if (userPubkeyHex !== currentOwner) {
      return handleAuthorizationError('Only the repository owner can update branch protection', { operation: 'updateBranchProtection', npub, repo });
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
      repo,
      validatedRules
    );

    // Sign and publish
    const signedEvent = await signEventWithNIP07(protectionEvent);
    
    const { outbox } = await getUserRelays(currentOwner, nostrClient);
    const combinedRelays = combineRelays(outbox);

    const result = await nostrClient.publishEvent(signedEvent, combinedRelays);

    if (result.success.length === 0) {
      return error(500, 'Failed to publish branch protection rules to relays');
    }

    return json({ success: true, event: signedEvent, rules: validatedRules });
  } catch (err) {
    return handleApiError(err, { operation: 'updateBranchProtection', npub, repo }, 'Failed to update branch protection');
  }
};
