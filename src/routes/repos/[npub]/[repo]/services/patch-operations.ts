/**
 * Patch operations service
 * Handles patch loading, creation, and status updates
 */

import type { RepoState } from '../stores/repo-state.js';
import { apiRequest } from '../utils/api-client.js';
import { nip19 } from 'nostr-tools';
import { NostrClient } from '$lib/services/nostr/nostr-client.js';
import { DEFAULT_NOSTR_RELAYS, combineRelays } from '$lib/config.js';
import { getUserRelays } from '$lib/services/nostr/user-relays.js';
import { isNIP07Available, signEventWithNIP07 } from '$lib/services/nostr/nip07-signer.js';
import { KIND } from '$lib/types/nostr.js';
import type { NostrEvent } from '$lib/types/nostr.js';

interface PatchOperationsCallbacks {
  loadPatches: () => Promise<void>;
}

/**
 * Load patches from the repository
 */
export async function loadPatches(
  state: RepoState,
  callbacks: PatchOperationsCallbacks
): Promise<void> {
  if (state.repoNotFound) return;
  state.loading.patches = true;
  state.error = null;
  try {
    const data = await apiRequest<Array<{
      id: string;
      tags: string[][];
      content: string;
      pubkey: string;
      created_at: number;
      kind?: number;
      status?: string;
    }>>(`/api/repos/${state.npub}/${state.repo}/patches`);
    
    state.patches = data.map((patch) => {
      // Extract subject/title from various sources
      let subject = patch.tags.find((t: string[]) => t[0] === 'subject')?.[1];
      const description = patch.tags.find((t: string[]) => t[0] === 'description')?.[1];
      const alt = patch.tags.find((t: string[]) => t[0] === 'alt')?.[1];
      
      // If no subject tag, try description or alt
      if (!subject) {
        if (description) {
          subject = description.trim();
        } else if (alt) {
          // Remove "git patch: " prefix if present
          subject = alt.replace(/^git patch:\s*/i, '').trim();
        } else {
          // Try to extract from patch content (git patch format)
          const subjectMatch = patch.content.match(/^Subject:\s*\[PATCH[^\]]*\]\s*(.+)$/m);
          if (subjectMatch) {
            subject = subjectMatch[1].trim();
          } else {
            // Try simpler Subject: line
            const simpleSubjectMatch = patch.content.match(/^Subject:\s*(.+)$/m);
            if (simpleSubjectMatch) {
              subject = simpleSubjectMatch[1].trim();
            }
          }
        }
      }
      
      return {
        id: patch.id,
        subject: subject || 'Untitled',
        content: patch.content,
        status: patch.status || 'open',
        author: patch.pubkey,
        created_at: patch.created_at,
        kind: patch.kind || KIND.PATCH,
        description: description?.trim(),
        tags: patch.tags || []
      };
    });
  } catch (err) {
    state.error = err instanceof Error ? err.message : 'Failed to load patches';
    console.error('Error loading patches:', err);
  } finally {
    state.loading.patches = false;
  }
}

/**
 * Create a new patch
 */
export async function createPatch(
  state: RepoState,
  callbacks: PatchOperationsCallbacks
): Promise<void> {
  if (!state.forms.patch.content.trim()) {
    alert('Please enter patch content');
    return;
  }

  if (!state.user.pubkey || !state.user.pubkeyHex) {
    alert('Please connect your NIP-07 extension');
    return;
  }

  state.creating.patch = true;
  state.error = null;

  try {
    const decoded = nip19.decode(state.npub);
    if (decoded.type !== 'npub') {
      throw new Error('Invalid npub format');
    }
    const repoOwnerPubkey = decoded.data as string;
    state.metadata.address = `${KIND.REPO_ANNOUNCEMENT}:${repoOwnerPubkey}:${state.repo}`;

    // Get user's relays and combine with defaults
    const tempClient = new NostrClient(DEFAULT_NOSTR_RELAYS);
    const { outbox } = await getUserRelays(state.user.pubkey, tempClient);
    const combinedRelays = combineRelays(outbox);

    // Create patch event (kind 1617)
    const patchEventTemplate: Omit<NostrEvent, 'sig' | 'id'> = {
      kind: KIND.PATCH,
      pubkey: state.user.pubkeyHex,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['a', state.metadata.address],
        ['p', repoOwnerPubkey],
        ['t', 'root']
      ],
      content: state.forms.patch.content.trim()
    };

    // Add subject if provided
    if (state.forms.patch.subject.trim()) {
      patchEventTemplate.tags.push(['subject', state.forms.patch.subject.trim()]);
    }

    // Sign the event using NIP-07
    const signedEvent = await signEventWithNIP07(patchEventTemplate);

    // Publish to all available relays
    const publishClient = new NostrClient(combinedRelays);
    const result = await publishClient.publishEvent(signedEvent, combinedRelays);

    if (result.failed.length > 0 && result.success.length === 0) {
      throw new Error('Failed to publish patch to all relays');
    }

    state.openDialog = null;
    state.forms.patch.content = '';
    state.forms.patch.subject = '';
    alert('Patch created successfully!');
    // Reload patches
    await callbacks.loadPatches();
  } catch (err) {
    state.error = err instanceof Error ? err.message : 'Failed to create patch';
    console.error('Error creating patch:', err);
  } finally {
    state.creating.patch = false;
  }
}

/**
 * Update patch status
 */
export async function updatePatchStatus(
  patchId: string,
  patchAuthor: string,
  status: string,
  state: RepoState,
  callbacks: PatchOperationsCallbacks
): Promise<void> {
  if (!state.user.pubkey || !state.user.pubkeyHex) {
    state.error = 'Please log in to update patch status';
    return;
  }

  state.statusUpdates.patch[patchId] = true;
  state.error = null;

  try {
    await apiRequest(`/api/repos/${state.npub}/${state.repo}/patches`, {
      method: 'PATCH',
      body: JSON.stringify({
        patchId,
        patchAuthor,
        status
      })
    } as RequestInit);

    // Reload patches to get updated status
    await callbacks.loadPatches();
  } catch (err) {
    state.error = err instanceof Error ? err.message : 'Failed to update patch status';
    console.error('Error updating patch status:', err);
  } finally {
    state.statusUpdates.patch[patchId] = false;
  }
}
