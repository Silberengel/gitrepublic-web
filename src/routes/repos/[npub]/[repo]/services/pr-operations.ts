/**
 * PR operations service
 * Handles pull request loading and creation
 */

import type { RepoState } from '../stores/repo-state.js';
import { apiRequest } from '../utils/api-client.js';
import { nip19 } from 'nostr-tools';
import { NostrClient } from '$lib/services/nostr/nostr-client.js';
import { DEFAULT_NOSTR_RELAYS, combineRelays, getGitUrl } from '$lib/config.js';
import { getUserRelays } from '$lib/services/nostr/user-relays.js';
import { KIND } from '$lib/types/nostr.js';

interface PROperationsCallbacks {
  loadPRs: () => Promise<void>;
}

/**
 * Load pull requests from the repository
 */
export async function loadPRs(
  state: RepoState,
  callbacks: PROperationsCallbacks
): Promise<void> {
  state.loading.prs = true;
  state.error = null;
  try {
    const data = await apiRequest<Array<{
      id: string;
      tags: string[][];
      content: string;
      status?: string;
      pubkey: string;
      created_at: number;
      commitId?: string;
      kind?: number;
    }>>(`/api/repos/${state.npub}/${state.repo}/prs`);
    
    state.prs = data.map((pr) => ({
      id: pr.id,
      subject: pr.tags.find((t: string[]) => t[0] === 'subject')?.[1] || 'Untitled',
      content: pr.content,
      status: pr.status || 'open',
      author: pr.pubkey,
      created_at: pr.created_at,
      commitId: pr.tags.find((t: string[]) => t[0] === 'c')?.[1],
      kind: pr.kind || KIND.PULL_REQUEST
    }));
  } catch (err) {
    state.error = err instanceof Error ? err.message : 'Failed to load pull requests';
  } finally {
    state.loading.prs = false;
  }
}

/**
 * Create a new pull request
 */
export async function createPR(
  state: RepoState,
  callbacks: PROperationsCallbacks
): Promise<void> {
  if (!state.forms.pr.subject.trim() || !state.forms.pr.content.trim() || !state.forms.pr.commitId.trim()) {
    alert('Please enter a subject, content, and commit ID');
    return;
  }

  if (!state.user.pubkey) {
    alert('Please connect your NIP-07 extension');
    return;
  }

  state.saving = true;
  state.error = null;

  try {
    const { PRsService } = await import('$lib/services/nostr/prs-service.js');
    
    const decoded = nip19.decode(state.npub);
    if (decoded.type !== 'npub') {
      throw new Error('Invalid npub format');
    }
    const repoOwnerPubkey = decoded.data as string;

    // Get user's relays and combine with defaults
    const tempClient = new NostrClient(DEFAULT_NOSTR_RELAYS);
    const { outbox } = await getUserRelays(state.user.pubkey, tempClient);
    const combinedRelays = combineRelays(outbox);

    const cloneUrl = getGitUrl(state.npub, state.repo);
    const prsService = new PRsService(combinedRelays);
    await prsService.createPullRequest(
      repoOwnerPubkey,
      state.repo,
      state.forms.pr.subject.trim(),
      state.forms.pr.content.trim(),
      state.forms.pr.commitId.trim(),
      cloneUrl,
      state.forms.pr.branchName.trim() || undefined,
      state.forms.pr.labels.filter(l => l.trim())
    );

    state.openDialog = null;
    state.forms.pr.subject = '';
    state.forms.pr.content = '';
    state.forms.pr.commitId = '';
    state.forms.pr.branchName = '';
    state.forms.pr.labels = [''];
    await callbacks.loadPRs();
    alert('Pull request created successfully!');
  } catch (err) {
    state.error = err instanceof Error ? err.message : 'Failed to create pull request';
    console.error('Error creating PR:', err);
  } finally {
    state.saving = false;
  }
}
