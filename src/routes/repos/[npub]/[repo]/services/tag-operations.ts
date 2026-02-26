/**
 * Tag operations service
 * Handles tag loading and creation
 */

import type { RepoState } from '../stores/repo-state.js';
import { apiRequest, apiPost } from '../utils/api-client.js';

interface TagOperationsCallbacks {
  loadTags: () => Promise<void>;
}

/**
 * Load tags from the repository
 */
export async function loadTags(
  state: RepoState,
  callbacks: TagOperationsCallbacks
): Promise<void> {
  if (state.repoNotFound) return;
  try {
    const tags = await apiRequest<Array<{ name: string; hash: string; message?: string; date?: number }>>(
      `/api/repos/${state.npub}/${state.repo}/tags`
    );
    state.git.tags = tags;
    // Auto-select first tag if none selected
    if (state.git.tags.length > 0 && !state.git.selectedTag) {
      state.git.selectedTag = state.git.tags[0].name;
    }
  } catch (err) {
    console.error('Failed to load tags:', err);
  }
}

/**
 * Create a new tag
 */
export async function createTag(
  state: RepoState,
  callbacks: TagOperationsCallbacks
): Promise<void> {
  if (!state.forms.tag.name.trim()) {
    alert('Please enter a tag name');
    return;
  }

  if (!state.user.pubkey) {
    alert('Please connect your NIP-07 extension');
    return;
  }

  state.saving = true;
  state.error = null;

  try {
    await apiPost(`/api/repos/${state.npub}/${state.repo}/tags`, {
      tagName: state.forms.tag.name,
      ref: state.forms.tag.ref,
      message: state.forms.tag.message || undefined,
      userPubkey: state.user.pubkey
    });

    state.openDialog = null;
    state.forms.tag.name = '';
    state.forms.tag.message = '';
    await callbacks.loadTags();
    alert('Tag created successfully!');
  } catch (err) {
    state.error = err instanceof Error ? err.message : 'Failed to create tag';
  } finally {
    state.saving = false;
  }
}
