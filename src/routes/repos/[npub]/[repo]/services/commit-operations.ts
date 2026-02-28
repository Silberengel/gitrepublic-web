/**
 * Commit operations service
 * Handles commit history loading, verification, and diff viewing
 */

import type { RepoState } from '../stores/repo-state.js';
import { apiRequest } from '../utils/api-client.js';

interface CommitOperationsCallbacks {
  verifyCommit: (commitHash: string) => Promise<void>;
}

/**
 * Load commit history
 */
export async function loadCommitHistory(
  state: RepoState,
  callbacks: CommitOperationsCallbacks
): Promise<void> {
  // Skip if repo is not cloned and no API fallback available
  if (state.clone.isCloned === false && !state.clone.apiFallbackAvailable) {
    state.loading.commits = false;
    state.error = null;
    state.git.commits = [];
    console.log('[loadCommitHistory] Skipping - repo not cloned and no API fallback available');
    return;
  }
  
  state.loading.commits = true;
  state.error = null;
  try {
    // Use currentBranch, fallback to defaultBranch, then 'master'
    const branch = state.git.currentBranch || state.git.defaultBranch || 'master';
    const url = `/api/repos/${state.npub}/${state.repo}/commits?branch=${encodeURIComponent(branch)}&limit=50`;
    console.log('[loadCommitHistory] Fetching commits:', { url, branch, currentBranch: state.git.currentBranch, defaultBranch: state.git.defaultBranch });
    
    const response = await apiRequest<Array<{
      hash?: string;
      sha?: string;
      message?: string;
      author?: string;
      date?: string;
      files?: string[];
    }> | { commitCount?: number; data?: Array<any> }>(url);
    
    // Handle both array and object response formats
    // API should return array, but handle object wrappers like { data: [] } or { commits: [] }
    let data: Array<any>;
    if (Array.isArray(response)) {
      data = response;
    } else if (response && typeof response === 'object') {
      // Try common wrapper formats
      data = (response as any).data || (response as any).commits || [];
    } else {
      data = [];
    }
    
    console.log('[loadCommitHistory] Received response:', { 
      responseType: Array.isArray(response) ? 'array' : typeof response,
      responseKeys: typeof response === 'object' && response !== null ? Object.keys(response) : [],
      commitCount: data?.length || 0,
      data 
    });
    
    // Normalize commits: API-based commits use 'sha', local commits use 'hash'
    state.git.commits = data.map((commit: any) => ({
      hash: commit.hash || commit.sha || '',
      message: commit.message || 'No message',
      author: commit.author || 'Unknown',
      date: commit.date || new Date().toISOString(),
      files: commit.files || []
    })).filter((commit: any) => commit.hash); // Filter out commits without hash
    
    console.log('[loadCommitHistory] Normalized commits:', { count: state.git.commits.length });
    
    // Verify commits in background (only for cloned repos)
    if (state.clone.isCloned === true) {
      state.git.commits.forEach(commit => {
        callbacks.verifyCommit(commit.hash).catch(err => {
          console.warn(`Failed to verify commit ${commit.hash}:`, err);
        });
      });
    }
  } catch (err) {
    console.error('[loadCommitHistory] Error loading commits:', err);
    const errorMessage = err instanceof Error ? err.message : 'Failed to load commit history';
    
    // Handle 404 gracefully - repo not cloned
    if (errorMessage.includes('404') || errorMessage.includes('not found') || errorMessage.includes('Repository not found')) {
      // If repo is not cloned, this is expected - don't set error
      if (state.clone.isCloned === false) {
        state.error = null;
        state.git.commits = [];
        console.log('[loadCommitHistory] Repo not cloned - commits unavailable');
      } else {
        state.error = errorMessage;
      }
    } else {
      state.error = errorMessage;
    }
  } finally {
    state.loading.commits = false;
  }
}

/**
 * Verify a commit signature
 */
export async function verifyCommit(
  commitHash: string,
  state: RepoState
): Promise<void> {
  if (state.git.verifyingCommits.has(commitHash)) return; // Already verifying
  if (!state.clone.isCloned) return; // Can't verify without local repo
  
  state.git.verifyingCommits.add(commitHash);
  try {
    const verification = await apiRequest<{
      valid: boolean;
      hasSignature?: boolean;
      error?: string;
      pubkey?: string;
      npub?: string;
      authorName?: string;
      authorEmail?: string;
      timestamp?: number;
      eventId?: string;
    }>(`/api/repos/${state.npub}/${state.repo}/commits/${commitHash}/verification`);
    
    // Only update verification if there's actually a signature
    // If hasSignature is false or undefined, don't set verification at all
    if (verification.hasSignature !== false) {
      const commitIndex = state.git.commits.findIndex(c => c.hash === commitHash);
      if (commitIndex >= 0) {
        state.git.commits[commitIndex].verification = verification;
      }
    }
  } catch (err) {
    console.warn(`Failed to verify commit ${commitHash}:`, err);
  } finally {
    state.git.verifyingCommits.delete(commitHash);
  }
}

/**
 * View diff for a commit
 */
export async function viewDiff(
  commitHash: string,
  state: RepoState
): Promise<void> {
  // Set selected commit immediately so it shows in the right panel
  state.git.selectedCommit = commitHash;
  state.git.showDiff = false; // Start with false, will be set to true when diff loads
  state.loading.commits = true;
  state.error = null;
  try {
    // Normalize commit hash (handle both 'hash' and 'sha' properties)
    const getCommitHash = (c: any) => c.hash || c.sha || '';
    const commitIndex = state.git.commits.findIndex(c => getCommitHash(c) === commitHash);
    
    // Determine parent hash: if this is the last commit (initial commit), use empty tree
    // Otherwise, use the next commit in the list or the parent commit
    let parentHash: string;
    if (commitIndex >= 0) {
      // Check if this is the last commit (initial commit with no parent)
      if (commitIndex === state.git.commits.length - 1) {
        // This is the initial commit - use empty tree hash
        // Git's empty tree hash: 4b825dc642cb6eb9a060e54bf8d69288fbee4904
        parentHash = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
      } else {
        // Use the next commit (which is the parent in reverse chronological order)
        parentHash = getCommitHash(state.git.commits[commitIndex + 1]);
      }
    } else {
      // Commit not found in list, try to use parent (but this might fail for initial commit)
      // We'll let the API handle the error
      parentHash = `${commitHash}^`;
    }
    
    const diffData = await apiRequest<Array<{
      file: string;
      additions: number;
      deletions: number;
      diff: string;
    }>>(`/api/repos/${state.npub}/${state.repo}/diffs?from=${parentHash}&to=${commitHash}`);
    
    state.git.diffData = diffData;
    state.git.showDiff = true;
  } catch (err) {
    // Handle 404 or other errors
    if (err instanceof Error) {
      if (err.message.includes('404') || err.message.includes('not found')) {
        // Check if this is an API fallback commit (repo not cloned or empty)
        if (state.clone.isCloned === false || (state.clone.isCloned === true && state.clone.apiFallbackAvailable)) {
          state.error = 'Diffs are not available for commits viewed via API fallback. Please clone the repository to view diffs.';
        } else {
          state.error = `Commit not found: ${err.message || 'The commit may not exist in the repository'}`;
        }
      } else if (err.message.includes('NetworkError')) {
        state.error = 'Network error: Unable to fetch diff. Please check your connection and try again.';
      } else {
        state.error = err.message || 'Failed to load diff';
      }
    } else {
      state.error = 'Failed to load diff';
    }
  } finally {
    state.loading.commits = false;
  }
}
