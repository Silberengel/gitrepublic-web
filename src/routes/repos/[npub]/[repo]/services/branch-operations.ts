/**
 * Branch operations service
 * Handles branch creation and deletion
 */

import type { NostrEvent } from '$lib/types/nostr.js';
import type { RepoState } from '../stores/repo-state.js';
import { apiPost, apiRequest, buildApiHeaders } from '../utils/api-client.js';

interface BranchOperationsCallbacks {
  loadBranches: () => Promise<void>;
  loadFiles: (path: string) => Promise<void>;
  loadFile: (path: string) => Promise<void>;
  loadReadme: () => Promise<void>;
  loadCommitHistory: () => Promise<void>;
  loadDocumentation: () => Promise<void>;
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

/**
 * Load branches from the repository
 */
export async function loadBranches(
  state: RepoState,
  repoCloneUrls: string[] | undefined
): Promise<void> {
  try {
    const data = await apiRequest<Array<string | { name: string; commit?: any }>>(
      `/api/repos/${state.npub}/${state.repo}/branches`
    );
    
    state.git.branches = data;
    
    // If repo is not cloned but we got branches, API fallback is available
    if (state.clone.isCloned === false && state.git.branches.length > 0) {
      state.clone.apiFallbackAvailable = true;
    }
    
    if (state.git.branches.length > 0) {
      // Branches can be an array of objects with .name property or array of strings
      const branchNames = state.git.branches.map((b: any) => typeof b === 'string' ? b : b.name);
      
      // Fetch the actual default branch from the API
      try {
        const defaultBranchData = await apiRequest<{ defaultBranch?: string; branch?: string }>(
          `/api/repos/${state.npub}/${state.repo}/default-branch`
        );
        state.git.defaultBranch = defaultBranchData.defaultBranch || defaultBranchData.branch || null;
      } catch (err) {
        console.warn('Failed to fetch default branch, using fallback logic:', err);
      }
      
      // Fallback: Detect default branch: prefer master, then main, then first branch
      if (!state.git.defaultBranch) {
        if (branchNames.includes('master')) {
          state.git.defaultBranch = 'master';
        } else if (branchNames.includes('main')) {
          state.git.defaultBranch = 'main';
        } else {
          state.git.defaultBranch = branchNames[0];
        }
      }
      
      // Only update currentBranch if it's not set or if the current branch doesn't exist
      // Also validate that currentBranch doesn't contain invalid characters (like '#')
      if (!state.git.currentBranch || 
          typeof state.git.currentBranch !== 'string' || 
          state.git.currentBranch.includes('#') ||
          !branchNames.includes(state.git.currentBranch)) {
        state.git.currentBranch = state.git.defaultBranch;
      }
    } else {
      // No branches exist - set currentBranch to null to show "no branches" in header
      state.git.currentBranch = null;
    }
  } catch (err: any) {
    // Handle 404 - repository not found or not cloned
    const errorMessage = err instanceof Error ? err.message : String(err);
    if (errorMessage.includes('404') || errorMessage.includes('not found')) {
      if (errorMessage.includes('not cloned locally')) {
        // Repository is not cloned - check if API fallback might be available
        if (repoCloneUrls && repoCloneUrls.length > 0) {
          // We have clone URLs, so API fallback might work - mark as unknown for now
          state.clone.apiFallbackAvailable = null;
        } else {
          // No clone URLs, API fallback won't work
          state.repoNotFound = true;
          state.clone.apiFallbackAvailable = false;
          state.error = errorMessage || `Repository not found. This repository exists in Nostr but hasn't been provisioned on this server yet. The server will automatically provision it soon, or you can contact the server administrator.`;
        }
      } else {
        // Generic 404 - repository doesn't exist
        state.repoNotFound = true;
        state.clone.apiFallbackAvailable = false;
        state.error = `Repository not found. This repository exists in Nostr but hasn't been provisioned on this server yet. The server will automatically provision it soon, or you can contact the server administrator.`;
      }
    } else if (errorMessage.includes('403') || errorMessage.includes('Access denied')) {
      // Access denied - don't set repoNotFound, allow retry after login
      state.error = `Access denied: ${errorMessage}. You may need to log in or you may not have permission to view this repository.`;
      console.warn('[Branches] Access denied, user may need to log in');
    } else {
      console.error('Failed to load branches:', err);
    }
  }
}

/**
 * Handle branch change
 */
export async function handleBranchChange(
  branch: string,
  state: RepoState,
  callbacks: BranchOperationsCallbacks
): Promise<void> {
  state.git.currentBranch = branch;
  
  // Reload all branch-dependent data
  const reloadPromises: Promise<void>[] = [];
  
  // Always reload files (and current file if open)
  if (state.files.currentFile) {
    reloadPromises.push(callbacks.loadFile(state.files.currentFile).catch(err => console.warn('Failed to reload file after branch change:', err)));
  } else {
    reloadPromises.push(callbacks.loadFiles(state.files.currentPath).catch(err => console.warn('Failed to reload files after branch change:', err)));
  }
  
  // Reload README (branch-specific)
  reloadPromises.push(callbacks.loadReadme().catch(err => console.warn('Failed to reload README after branch change:', err)));
  
  // Reload commit history if history tab is active
  if (state.ui.activeTab === 'history') {
    reloadPromises.push(callbacks.loadCommitHistory().catch(err => console.warn('Failed to reload commit history after branch change:', err)));
  }
  
  // Reload documentation if docs tab is active (might be branch-specific)
  if (state.ui.activeTab === 'docs') {
    // Reset documentation to force reload
    state.docs.html = null;
    state.docs.content = null;
    state.docs.kind = null;
    reloadPromises.push(callbacks.loadDocumentation().catch(err => console.warn('Failed to reload documentation after branch change:', err)));
  }
  
  // Wait for all reloads to complete
  await Promise.all(reloadPromises);
}
