/**
 * Repo operations service
 * Handles repository-level operations: clone, fork, bookmark, verification, maintainers
 */

import type { RepoState } from '../stores/repo-state.js';
import { apiRequest, apiPost } from '../utils/api-client.js';
import { buildApiHeaders } from '../utils/api-client.js';
import { nip19 } from 'nostr-tools';
import { NostrClient } from '$lib/services/nostr/nostr-client.js';
import { DEFAULT_NOSTR_RELAYS, DEFAULT_NOSTR_SEARCH_RELAYS, combineRelays } from '$lib/config.js';
import { getUserRelays } from '$lib/services/nostr/user-relays.js';
import { KIND } from '$lib/types/nostr.js';
import type { NostrEvent } from '$lib/types/nostr.js';
import { goto } from '$app/navigation';

interface RepoOperationsCallbacks {
  checkCloneStatus: (force: boolean) => Promise<void>;
  loadBranches: () => Promise<void>;
  loadFiles: (path: string) => Promise<void>;
  loadReadme: () => Promise<void>;
  loadTags: () => Promise<void>;
  loadCommitHistory: () => Promise<void>;
}

/**
 * Check clone status
 */
export async function checkCloneStatus(
  force: boolean,
  state: RepoState,
  repoCloneUrls: string[] | undefined
): Promise<void> {
  if (state.clone.checking && !force) return;
  if (!force && state.clone.isCloned !== null) {
    console.log(`[Clone Status] Skipping check - already checked: ${state.clone.isCloned}, force: ${force}`);
    return;
  }
  
  state.clone.checking = true;
  try {
    // Check if repo exists locally by trying to fetch branches
    // Use skipApiFallback parameter to ensure we only check local repo, not API fallback
    // 404 = repo not cloned, 403 = repo exists but access denied (cloned), 200 = cloned and accessible
    const url = `/api/repos/${state.npub}/${state.repo}/branches?skipApiFallback=true`;
    console.log(`[Clone Status] Checking clone status for ${state.npub}/${state.repo}...`);
    const response = await fetch(url, {
      headers: buildApiHeaders()
    });
    
    // If response is 403, repo exists (cloned) but user doesn't have access
    // If response is 404, repo doesn't exist (not cloned)
    // If response is 200, repo exists and is accessible (cloned)
    const wasCloned = response.status !== 404;
    state.clone.isCloned = wasCloned;
    
    // If repo is not cloned, check if API fallback is available
    if (!wasCloned) {
      // Try to detect API fallback by checking if we have clone URLs
      if (repoCloneUrls && repoCloneUrls.length > 0) {
        // We have clone URLs, so API fallback might work - will be detected when loadBranches() runs
        state.clone.apiFallbackAvailable = null; // Will be set to true if a subsequent request succeeds
      } else {
        state.clone.apiFallbackAvailable = false;
      }
    } else {
      // Repo is cloned, API fallback not needed
      state.clone.apiFallbackAvailable = false;
    }
    
    console.log(`[Clone Status] Repo ${wasCloned ? 'is cloned' : 'is not cloned'} (status: ${response.status}), API fallback: ${state.clone.apiFallbackAvailable}`);
  } catch (err) {
    // On error, assume not cloned
    console.warn('[Clone Status] Error checking clone status:', err);
    state.clone.isCloned = false;
    state.clone.apiFallbackAvailable = false;
  } finally {
    state.clone.checking = false;
  }
}

/**
 * Clone repository
 */
export async function cloneRepository(
  state: RepoState,
  callbacks: RepoOperationsCallbacks
): Promise<void> {
  if (state.clone.cloning) return;
  
  state.clone.cloning = true;
  try {
    const data = await apiPost<{ alreadyExists?: boolean }>(`/api/repos/${state.npub}/${state.repo}/clone`, {});
    
    if (data.alreadyExists) {
      alert('Repository already exists locally.');
      // Force refresh clone status
      await callbacks.checkCloneStatus(true);
    } else {
      alert('Repository cloned successfully! The repository is now available on this server.');
      // Force refresh clone status
      await callbacks.checkCloneStatus(true);
      // Reset API fallback status since repo is now cloned
      state.clone.apiFallbackAvailable = false;
      // Reload data to use the cloned repo instead of API
      await Promise.all([
        callbacks.loadBranches(),
        callbacks.loadFiles(state.files.currentPath),
        callbacks.loadReadme(),
        callbacks.loadTags(),
        callbacks.loadCommitHistory()
      ]);
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Failed to clone repository';
    alert(`Error: ${errorMessage}`);
    console.error('Error cloning repository:', err);
  } finally {
    state.clone.cloning = false;
  }
}

/**
 * Fork repository
 */
export async function forkRepository(
  state: RepoState
): Promise<void> {
  if (!state.user.pubkey) {
    alert('Please connect your NIP-07 extension');
    return;
  }

  state.fork.forking = true;
  state.error = null;

  try {
    // Security: Truncate npub in logs
    const truncatedNpub = state.npub.length > 16 ? `${state.npub.slice(0, 12)}...` : state.npub;
    console.log(`[Fork UI] Starting fork of ${truncatedNpub}/${state.repo}...`);
    
    const data = await apiPost<{
      success?: boolean;
      message?: string;
      fork?: {
        npub: string;
        repo: string;
        publishedTo?: { announcement?: number };
        announcementId?: string;
        ownershipTransferId?: string;
      };
      error?: string;
      details?: string;
      eventName?: string;
    }>(`/api/repos/${state.npub}/${state.repo}/fork`, { userPubkey: state.user.pubkey });
    
    if (data.success !== false && data.fork) {
      const message = data.message || `Repository forked successfully! Published to ${data.fork.publishedTo?.announcement || 0} relay(s).`;
      console.log(`[Fork UI] ✓ ${message}`);
      // Security: Truncate npub in logs
      const truncatedForkNpub = data.fork.npub.length > 16 ? `${data.fork.npub.slice(0, 12)}...` : data.fork.npub;
      console.log(`[Fork UI]   - Fork location: /repos/${truncatedForkNpub}/${data.fork.repo}`);
      console.log(`[Fork UI]   - Announcement ID: ${data.fork.announcementId}`);
      console.log(`[Fork UI]   - Ownership Transfer ID: ${data.fork.ownershipTransferId}`);
      
      alert(`${message}\n\nRedirecting to your fork...`);
      goto(`/repos/${data.fork.npub}/${data.fork.repo}`);
    } else {
      const errorMessage = data.error || 'Failed to fork repository';
      const errorDetails = data.details ? `\n\nDetails: ${data.details}` : '';
      const fullError = `${errorMessage}${errorDetails}`;
      
      console.error(`[Fork UI] ✗ Fork failed: ${errorMessage}`);
      if (data.details) {
        console.error(`[Fork UI] Details: ${data.details}`);
      }
      if (data.eventName) {
        console.error(`[Fork UI] Failed event: ${data.eventName}`);
      }
      
      state.error = fullError;
      alert(`Fork failed!\n\n${fullError}`);
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Failed to fork repository';
    console.error(`[Fork UI] ✗ Unexpected error: ${errorMessage}`, err);
    state.error = errorMessage;
    alert(`Fork failed!\n\n${errorMessage}`);
  } finally {
    state.fork.forking = false;
  }
}

/**
 * Toggle bookmark
 */
export async function toggleBookmark(
  state: RepoState,
  bookmarksService: any
): Promise<void> {
  if (!state.user.pubkey || !state.metadata.address || !bookmarksService || state.loading.bookmark) return;
  
  state.loading.bookmark = true;
  try {
    // Get user's relays for publishing
    const allSearchRelays = [...new Set([...DEFAULT_NOSTR_SEARCH_RELAYS, ...DEFAULT_NOSTR_RELAYS])];
    const fullRelayClient = new NostrClient(allSearchRelays);
    const { outbox, inbox } = await getUserRelays(state.user.pubkey, fullRelayClient);
    const userRelays = combineRelays(outbox.length > 0 ? outbox : inbox, DEFAULT_NOSTR_RELAYS);
    
    let success = false;
    if (state.bookmark.isBookmarked) {
      success = await bookmarksService.removeBookmark(state.user.pubkey, state.metadata.address, userRelays);
    } else {
      success = await bookmarksService.addBookmark(state.user.pubkey, state.metadata.address, userRelays);
    }
    
    if (success) {
      state.bookmark.isBookmarked = !state.bookmark.isBookmarked;
    } else {
      alert(`Failed to ${state.bookmark.isBookmarked ? 'remove' : 'add'} bookmark. Please try again.`);
    }
  } catch (err) {
    console.error('Failed to toggle bookmark:', err);
    alert(`Failed to ${state.bookmark.isBookmarked ? 'remove' : 'add'} bookmark: ${String(err)}`);
  } finally {
    state.loading.bookmark = false;
  }
}

/**
 * Check maintainer status
 */
export async function checkMaintainerStatus(
  state: RepoState
): Promise<void> {
  if (state.repoNotFound || !state.user.pubkey) {
    state.maintainers.isMaintainer = false;
    return;
  }

  state.loading.maintainerStatus = true;
  try {
    const data = await apiRequest<{ isMaintainer?: boolean }>(
      `/api/repos/${state.npub}/${state.repo}/maintainers?userPubkey=${encodeURIComponent(state.user.pubkey)}`
    );
    state.maintainers.isMaintainer = data.isMaintainer || false;
  } catch (err) {
    console.error('Failed to check maintainer status:', err);
    state.maintainers.isMaintainer = false;
  } finally {
    state.loading.maintainerStatus = false;
  }
}

/**
 * Load all maintainers
 */
export async function loadAllMaintainers(
  state: RepoState,
  repoOwnerPubkeyDerived: string | null,
  repoMaintainers: string[] | undefined
): Promise<void> {
  if (state.repoNotFound || state.loading.maintainers) return;
  
  state.loading.maintainers = true;
  try {
    const data = await apiRequest<{
      owner?: string;
      maintainers?: string[];
    }>(`/api/repos/${state.npub}/${state.repo}/maintainers`);
    
    const owner = data.owner;
    const maintainers = data.maintainers || [];
    
    // Create array with all maintainers, marking the owner
    const allMaintainersList: Array<{ pubkey: string; isOwner: boolean }> = [];
    const seen = new Set<string>();
    const ownerLower = owner?.toLowerCase();
    
    // Process all maintainers, marking owner and deduplicating
    for (const maintainer of maintainers) {
      const maintainerLower = maintainer.toLowerCase();
      
      // Skip if we've already added this pubkey (case-insensitive check)
      if (seen.has(maintainerLower)) {
        continue;
      }
      
      // Mark as seen
      seen.add(maintainerLower);
      
      // Determine if this is the owner
      const isOwner = ownerLower && maintainerLower === ownerLower;
      
      // Add to list
      allMaintainersList.push({ 
        pubkey: maintainer, 
        isOwner: !!isOwner
      });
    }
    
    // Sort: owner first, then other maintainers
    allMaintainersList.sort((a, b) => {
      if (a.isOwner && !b.isOwner) return -1;
      if (!a.isOwner && b.isOwner) return 1;
      return 0;
    });
    
    // Ensure owner is always included (in case they weren't in maintainers list)
    if (owner && ownerLower && !seen.has(ownerLower)) {
      allMaintainersList.unshift({ pubkey: owner, isOwner: true });
    }
    
    state.maintainers.all = allMaintainersList;
  } catch (err) {
    console.error('Failed to load maintainers:', err);
    state.maintainers.loaded = false; // Reset flag on error
    // Fallback to pageData if available
    if (repoOwnerPubkeyDerived) {
      state.maintainers.all = [{ pubkey: repoOwnerPubkeyDerived, isOwner: true }];
      if (repoMaintainers) {
        for (const maintainer of repoMaintainers) {
          if (maintainer.toLowerCase() !== repoOwnerPubkeyDerived.toLowerCase()) {
            state.maintainers.all.push({ pubkey: maintainer, isOwner: false });
          }
        }
      }
    }
  } finally {
    state.loading.maintainers = false;
  }
}

/**
 * Check verification status
 */
export async function checkVerification(
  state: RepoState
): Promise<void> {
  if (state.repoNotFound) return;
  state.loading.verification = true;
  try {
    const data = await apiRequest<{
      verified?: boolean;
      error?: string;
      message?: string;
      cloneVerifications?: Array<{ url: string; verified: boolean; ownerPubkey: string | null; error?: string }>;
    }>(`/api/repos/${state.npub}/${state.repo}/verify`);
    
    console.log('[Verification] Response:', data);
    state.verification.status = {
      verified: data.verified ?? false,
      error: data.error,
      message: data.message,
      cloneVerifications: data.cloneVerifications
    };
  } catch (err) {
    console.error('[Verification] Failed to check verification:', err);
    state.verification.status = { verified: false, error: 'Failed to check verification' };
  } finally {
    state.loading.verification = false;
    console.log('[Verification] Status after check:', state.verification.status);
  }
}
