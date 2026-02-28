/**
 * Code search operations service
 * Handles code search functionality
 */

import type { RepoState } from '../stores/repo-state.js';
import { apiRequest, buildApiHeaders } from '../utils/api-client.js';

/**
 * Perform code search
 */
export async function performCodeSearch(
  state: RepoState
): Promise<void> {
  if (!state.codeSearch.query.trim() || state.codeSearch.query.length < 2) {
    state.codeSearch.results = [];
    return;
  }

  state.loading.codeSearch = true;
  state.error = null;

  try {
    // Get current branch for repo-specific search
    const branchParam = state.codeSearch.scope === 'repo' && state.git.currentBranch 
      ? `&branch=${encodeURIComponent(state.git.currentBranch)}` 
      : '';
    
    // For "All Repositories", don't pass repo filter - let it search all repos
    const repoParam = state.codeSearch.scope === 'repo' ? `&repo=${encodeURIComponent(`${state.npub}/${state.repo}`)}` : '';
    const url = `/api/search?type=code&q=${encodeURIComponent(state.codeSearch.query.trim())}${repoParam}${branchParam}`;
    
    const data = await apiRequest<Array<any>>(url);
    state.codeSearch.results = Array.isArray(data) ? data : [];
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Failed to search code';
    console.error('[Code Search] Error:', err);
    state.error = errorMessage;
    state.codeSearch.results = [];
  } finally {
    state.loading.codeSearch = false;
  }
}
