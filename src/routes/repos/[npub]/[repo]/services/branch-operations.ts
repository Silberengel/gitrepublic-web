/**
 * Branch operations service
 * Handles branch creation and deletion
 */

import type { NostrEvent } from '$lib/types/nostr.js';
import type { RepoState } from '../stores/repo-state.js';
import { apiPost, apiRequest } from '../utils/api-client.js';

interface BranchOperationsCallbacks {
  loadBranches: () => Promise<void>;
}

/**
 * Create a new branch
 */
export async function createBranch(
  state: RepoState,
  repoAnnouncement: NostrEvent | null | undefined,
  callbacks: BranchOperationsCallbacks
): Promise<void> {
  if (!state.forms.branch.name.trim()) {
    alert('Please enter a branch name');
    return;
  }

  state.saving = true;
  state.error = null;

  try {
    // If no branches exist, don't pass fromBranch (will use --orphan)
    // Otherwise, use the selected branch or current branch
    let fromBranch: string | undefined = state.forms.branch.from || state.git.currentBranch || undefined;
    
    // Include announcement if available (for empty repos)
    const requestBody: { branchName: string; fromBranch?: string; announcement?: NostrEvent } = {
      branchName: state.forms.branch.name
    };
    if (state.git.branches.length > 0 && fromBranch) {
      requestBody.fromBranch = fromBranch;
    }
    // Pass announcement if available (especially useful for empty repos)
    if (repoAnnouncement) {
      requestBody.announcement = repoAnnouncement;
    }

    await apiPost(`/api/repos/${state.npub}/${state.repo}/branches`, requestBody);

    state.openDialog = null;
    state.forms.branch.name = '';
    await callbacks.loadBranches();
    alert('Branch created successfully!');
  } catch (err) {
    state.error = err instanceof Error ? err.message : 'Failed to create branch';
  } finally {
    state.saving = false;
  }
}

/**
 * Delete a branch
 */
export async function deleteBranch(
  branchName: string,
  state: RepoState,
  callbacks: BranchOperationsCallbacks
): Promise<void> {
  if (!confirm(`Are you sure you want to delete the branch "${branchName}"?\n\nThis will permanently delete the branch from the repository. This action CANNOT be undone.\n\nClick OK to delete, or Cancel to abort.`)) {
    return;
  }

  if (!state.user.pubkey) {
    alert('Please connect your NIP-07 extension');
    return;
  }

  // Prevent deleting the current branch
  if (branchName === state.git.currentBranch) {
    alert('Cannot delete the currently selected branch. Please switch to a different branch first.');
    return;
  }

  state.saving = true;
  state.error = null;

  try {
    // Note: DELETE endpoint expects branchName in body, not query string
    await apiRequest(`/api/repos/${state.npub}/${state.repo}/branches`, {
      method: 'DELETE',
      body: JSON.stringify({ branchName })
    });

    await callbacks.loadBranches();
    alert('Branch deleted successfully!');
  } catch (err) {
    state.error = err instanceof Error ? err.message : 'Failed to delete branch';
    alert(state.error);
  } finally {
    state.saving = false;
  }
}
