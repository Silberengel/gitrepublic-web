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
import logger from '$lib/services/logger.js';
import { isNIP07Available } from '$lib/services/nostr/nip07-signer.js';

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
    // If response is 404, repo doesn't exist (not cloned) - this is expected, not an error
    // If response is 200, repo exists and is accessible (cloned)
    const wasCloned = response.status !== 404;
    state.clone.isCloned = wasCloned;
    
    // If repo is not cloned, check if API fallback is available
    if (!wasCloned) {
      // Try to detect API fallback by checking if we have clone URLs
      if (repoCloneUrls && repoCloneUrls.length > 0) {
        // We have clone URLs, so API fallback might work - will be detected when loadBranches() runs
        // Set a timeout to mark as unavailable if not determined within 5 seconds
        state.clone.apiFallbackAvailable = null; // Will be set to true if a subsequent request succeeds
        setTimeout(() => {
          // If still null after 5 seconds, assume API fallback is unavailable
          // (loadBranches should have set it by now if it worked)
          if (state.clone.apiFallbackAvailable === null && state.clone.isCloned === false) {
            state.clone.apiFallbackAvailable = false;
            console.log('[Clone Status] API fallback check timeout - assuming unavailable');
          }
        }, 5000);
      } else {
        state.clone.apiFallbackAvailable = false;
      }
    } else {
      // Repo is cloned, API fallback not needed
      state.clone.apiFallbackAvailable = false;
    }
    
    // Only log as info, not error - 404 is expected when repo isn't cloned
    if (response.status === 404) {
      console.log(`[Clone Status] Repo is not cloned (status: 404 - expected), API fallback: ${state.clone.apiFallbackAvailable}`);
    } else {
      console.log(`[Clone Status] Repo ${wasCloned ? 'is cloned' : 'is not cloned'} (status: ${response.status}), API fallback: ${state.clone.apiFallbackAvailable}`);
    }
  } catch (err) {
    // On error, assume not cloned - but don't log as error since 404s are expected
    // Only log network errors or unexpected errors
    if (err instanceof TypeError && err.message.includes('fetch')) {
      // Network error - might be offline or CORS issue
      console.warn('[Clone Status] Network error checking clone status (may be offline):', err);
    } else {
      // Unexpected error
      console.warn('[Clone Status] Error checking clone status:', err);
    }
    state.clone.isCloned = false;
    // If we have clone URLs, API fallback might still work
    state.clone.apiFallbackAvailable = (repoCloneUrls && repoCloneUrls.length > 0) ? null : false;
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
  
  if (!state.user.pubkeyHex) {
    alert('Please log in to clone repositories.');
    return;
  }

  state.clone.cloning = true;
  try {
    // Create and send proof event to verify write access
    // This ensures the clone endpoint can verify access even if cache is empty
    let proofEvent: NostrEvent | null = null;
    try {
      if (isNIP07Available() && state.user.pubkeyHex) {
        const { createProofEvent } = await import('$lib/services/nostr/relay-write-proof.js');
        const { signEventWithNIP07 } = await import('$lib/services/nostr/nip07-signer.js');
        
        // Create proof event template
        const proofEventTemplate = createProofEvent(
          state.user.pubkeyHex,
          `gitrepublic-clone-proof-${Date.now()}`
        );
        
        // Sign with NIP-07
        proofEvent = await signEventWithNIP07(proofEventTemplate);
        
        // Publish to relays so server can verify it
        // User only needs write access to ONE relay, not all
        const nostrClient = new NostrClient(DEFAULT_NOSTR_RELAYS);
        let publishResult;
        try {
          publishResult = await nostrClient.publishEvent(proofEvent, DEFAULT_NOSTR_RELAYS).catch((err: unknown) => {
            // Catch any unhandled errors from publishEvent
            const errorMessage = err instanceof Error ? err.message : String(err);
            logger.debug({ error: errorMessage }, '[Clone] Error in publishEvent, marking all relays as failed');
            // Return a result with all relays failed
            return {
              success: [],
              failed: DEFAULT_NOSTR_RELAYS.map(relay => ({ relay, error: errorMessage }))
            };
          });
        } catch (err) {
          // Catch synchronous errors
          const errorMessage = err instanceof Error ? err.message : String(err);
          logger.debug({ error: errorMessage }, '[Clone] Synchronous error publishing proof event');
          publishResult = {
            success: [],
            failed: DEFAULT_NOSTR_RELAYS.map(relay => ({ relay, error: errorMessage }))
          };
        }
        
        // If at least one relay accepted the event, wait for propagation
        // If all relays failed, still try (might be cached or server can retry)
        if (publishResult && publishResult.success.length > 0) {
          logger.debug({ 
            successCount: publishResult.success.length, 
            successfulRelays: publishResult.success,
            failedRelays: publishResult.failed.map(f => f.relay)
          }, '[Clone] Proof event published to at least one relay, waiting for propagation');
          // Wait longer for event to propagate to relays (3 seconds should be enough)
          await new Promise(resolve => setTimeout(resolve, 3000));
        } else {
          const failedDetails = publishResult?.failed.map(f => `${f.relay}: ${f.error}`) || ['Unknown error'];
          logger.warn({ 
            failedRelays: failedDetails
          }, '[Clone] Proof event failed to publish to all relays, but continuing (server may retry or use cache)');
          // Still wait a bit in case some relays are slow
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
        // Clean up client
        try {
          nostrClient.close();
        } catch (closeErr) {
          // Ignore close errors
          logger.debug({ error: closeErr }, '[Clone] Error closing NostrClient');
        }
      }
    } catch (proofErr) {
      // If proof creation fails, continue anyway - clone endpoint will check cache
      logger.debug({ error: proofErr }, '[Clone] Failed to create proof event, will rely on cache');
    }

    // Get user's default branch preference from settings
    let defaultBranch: string | undefined;
    try {
      const { settingsStore } = await import('$lib/services/settings-store.js');
      const settings = await settingsStore.getSettings();
      if (settings.defaultBranch) {
        defaultBranch = settings.defaultBranch;
        logger.debug({ defaultBranch }, '[Clone] Using default branch from user settings');
      }
    } catch (settingsErr) {
      logger.debug({ error: settingsErr }, '[Clone] Failed to get default branch from settings');
    }

    // Send clone request with proof event and defaultBranch in body (if available)
    const requestBody: { proofEvent?: NostrEvent; defaultBranch?: string } = {};
    if (proofEvent) {
      requestBody.proofEvent = proofEvent;
    }
    if (defaultBranch) {
      requestBody.defaultBranch = defaultBranch;
    }
    
    logger.debug({ 
      npub: state.npub, 
      repo: state.repo, 
      hasProofEvent: !!proofEvent,
      defaultBranch 
    }, '[Clone] Sending clone request to server');
    
    const cloneUrl = `/api/repos/${state.npub}/${state.repo}/clone`;
    logger.debug({ url: cloneUrl }, '[Clone] POST request URL');
    
    const data = await apiPost<{ alreadyExists?: boolean; success?: boolean; message?: string }>(cloneUrl, requestBody);
    
    logger.debug({ data }, '[Clone] Clone request successful');
    
    // Check if the response indicates success
    if (data.success === false) {
      const errorMsg = data.message || 'Failed to clone repository';
      logger.error({ npub: state.npub, repo: state.repo, data }, '[Clone] Clone endpoint returned success: false');
      alert(`Error: ${errorMsg}`);
      throw new Error(errorMsg);
    }
    
    if (data.alreadyExists) {
      alert('Repository already exists locally.');
      // Force refresh clone status
      await callbacks.checkCloneStatus(true);
    } else {
      alert('Repository clone initiated. Waiting for clone to complete...');
      
      // Start polling for clone status with a delay
      // Clone operation may take time, so we poll every 2 seconds
      const pollInterval = 2000; // 2 seconds
      const maxAttempts = 30; // Maximum 60 seconds (30 * 2s)
      let attempts = 0;
      let pollTimer: ReturnType<typeof setInterval> | null = null;
      
      const pollCloneStatus = async () => {
        attempts++;
        logger.debug({ attempts, maxAttempts }, '[Clone] Polling clone status');
        
        // Check clone status
        await callbacks.checkCloneStatus(true);
        
        // If repo is now cloned, stop polling and reload data
        if (state.clone.isCloned === true) {
          if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
          }
          
          logger.info({ attempts }, '[Clone] Repository confirmed cloned, reloading data');
          
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
          
          logger.info('[Clone] Repository data reloaded successfully');
        } else if (attempts >= maxAttempts) {
          // Stop polling after max attempts
          if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
          }
          
          logger.warn({ attempts }, '[Clone] Polling timeout - clone may still be in progress');
          alert('Clone operation is taking longer than expected. The repository may still be cloning in the background. Please refresh the page in a moment.');
        }
      };
      
      // Start polling after initial delay of 2 seconds
      setTimeout(() => {
        pollCloneStatus(); // First check immediately after delay
        pollTimer = setInterval(pollCloneStatus, pollInterval);
      }, pollInterval);
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Failed to clone repository';
    logger.error({ 
      error: err, 
      npub: state.npub, 
      repo: state.repo,
      errorMessage,
      errorStack: err instanceof Error ? err.stack : undefined
    }, '[Clone] Clone request failed');
    
    // Extract more detailed error message if available
    let userFriendlyMessage = errorMessage;
    if (err instanceof Error) {
      // Check if it's a network error
      if (errorMessage.includes('fetch') || errorMessage.includes('network') || errorMessage.includes('Failed to fetch')) {
        userFriendlyMessage = 'Network error: Unable to connect to the server. Please check your connection and try again.';
      } else if (errorMessage.includes('403') || errorMessage.includes('Forbidden')) {
        userFriendlyMessage = 'Access denied: You do not have permission to clone this repository. Please verify you have unlimited access.';
      } else if (errorMessage.includes('404') || errorMessage.includes('Not found')) {
        userFriendlyMessage = 'Repository not found: The repository announcement may not exist or the repository name may be incorrect.';
      } else if (errorMessage.includes('timeout') || errorMessage.includes('timed out')) {
        userFriendlyMessage = 'Clone operation timed out. The repository may be too large or the remote server may be slow. Please try again.';
      }
    }
    
    alert(`Error cloning repository: ${userFriendlyMessage}`);
    console.error('Error cloning repository:', err);
  } finally {
    state.clone.cloning = false;
  }
}

/**
 * Fork repository
 */
export async function forkRepository(
  state: RepoState,
  localOnly: boolean = false
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
    console.log(`[Fork UI] Starting ${localOnly ? 'local-only ' : ''}fork of ${truncatedNpub}/${state.repo}...`);
    
    // Create a proof event to verify write access if needed
    let proofEvent: any = null;
    try {
      const { createProofEvent } = await import('$lib/services/nostr/relay-write-proof.js');
      const { signEventWithNIP07 } = await import('$lib/services/nostr/nip07-signer.js');
      const { DEFAULT_NOSTR_RELAYS } = await import('$lib/config.js');
      const { NostrClient } = await import('$lib/services/nostr/nostr-client.js');
      
      if (state.user.pubkeyHex) {
        const proofEventTemplate = createProofEvent(
          state.user.pubkeyHex,
          `gitrepublic-fork-proof-${Date.now()}`
        );
        
        proofEvent = await signEventWithNIP07(proofEventTemplate);
        
        // Publish the event to relays so server can verify it
        const nostrClient = new NostrClient(DEFAULT_NOSTR_RELAYS);
        await nostrClient.publishEvent(proofEvent, DEFAULT_NOSTR_RELAYS);
        
        // Wait a moment for the event to propagate
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } catch (proofErr) {
      console.warn('[Fork] Failed to create proof event, continuing without it:', proofErr);
      // Continue without proof event - server will check cache or return helpful error
    }
    
    const data = await apiPost<{
      success?: boolean;
      message?: string;
      redirect?: string;
      fork?: {
        npub: string;
        repo: string;
        localOnly?: boolean;
        publishedTo?: { announcement?: number; ownershipTransfer?: number } | null;
        announcementId?: string;
        ownershipTransferId?: string;
      };
      error?: string;
      details?: string;
      eventName?: string;
    }>(`/api/repos/${state.npub}/${state.repo}/forks`, { 
      userPubkey: state.user.pubkey,
      localOnly,
      proofEvent 
    });
    
    if (data.success !== false) {
      if (data.redirect) {
        // Redirect to signup page to publish the fork announcement
        console.log(`[Fork UI] ✓ Fork repository created! Redirecting to signup page to publish announcement...`);
        goto(data.redirect);
      } else if (data.fork) {
        // Legacy: Fork was fully created and published (shouldn't happen with new flow)
        const message = data.message || (data.fork.localOnly 
          ? 'Local-only fork created successfully! This fork is private and only exists on this server.'
          : `Repository forked successfully! Published to ${data.fork.publishedTo?.announcement || 0} relay(s).`);
        console.log(`[Fork UI] ✓ ${message}`);
        // Security: Truncate npub in logs
        const truncatedForkNpub = data.fork.npub.length > 16 ? `${data.fork.npub.slice(0, 12)}...` : data.fork.npub;
        console.log(`[Fork UI]   - Fork location: /repos/${truncatedForkNpub}/${data.fork.repo}`);
        console.log(`[Fork UI]   - Local-only: ${data.fork.localOnly || false}`);
        console.log(`[Fork UI]   - Announcement ID: ${data.fork.announcementId}`);
        console.log(`[Fork UI]   - Ownership Transfer ID: ${data.fork.ownershipTransferId}`);
        
        alert(`${message}\n\nRedirecting to your fork...`);
        goto(`/repos/${data.fork.npub}/${data.fork.repo}`);
      }
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
    }>(`/api/repos/${state.npub}/${state.repo}/verification`);
    
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
    
    // Log verification status for maintenance
    if (state.verification.status) {
      const status = state.verification.status;
      console.log('[Verification Status]', {
        verified: status.verified,
        error: status.error || null,
        message: status.message || null,
        cloneCount: status.cloneVerifications?.length || 0,
        verifiedClones: status.cloneVerifications?.filter(cv => cv.verified).length || 0,
        cloneDetails: status.cloneVerifications?.map(cv => ({
          url: cv.url.substring(0, 50) + (cv.url.length > 50 ? '...' : ''),
          verified: cv.verified,
          error: cv.error || null
        })) || []
      });
    } else {
      console.log('[Verification Status] Not available');
    }
  }
}

/**
 * Load bookmark status
 */
export async function loadBookmarkStatus(
  state: RepoState,
  bookmarksService: any
): Promise<void> {
  if (!state.user.pubkey || !state.metadata.address || !bookmarksService) return;
  
  try {
    state.bookmark.isBookmarked = await bookmarksService.isBookmarked(state.user.pubkey, state.metadata.address);
  } catch (err) {
    console.warn('Failed to load bookmark status:', err);
  }
}

/**
 * Load clone URL reachability status
 */
export async function loadCloneUrlReachability(
  forceRefresh: boolean,
  state: RepoState,
  repoCloneUrls: string[] | undefined
): Promise<void> {
  if (!repoCloneUrls || repoCloneUrls.length === 0) {
    return;
  }
  
  if (state.loading.reachability) return;
  
  state.loading.reachability = true;
  try {
    const data = await apiRequest<{
      results?: Array<{
        url: string;
        reachable: boolean;
        error?: string;
        checkedAt: number;
        serverType?: 'git' | 'grasp' | 'unknown';
      }>;
    }>(`/api/repos/${state.npub}/${state.repo}/clone-urls/reachability${forceRefresh ? '?forceRefresh=true' : ''}`);
    
    const newMap = new Map<string, { reachable: boolean; error?: string; checkedAt: number; serverType: 'git' | 'grasp' | 'unknown' }>();
    
    if (data.results && Array.isArray(data.results)) {
      for (const result of data.results) {
        newMap.set(result.url, {
          reachable: result.reachable,
          error: result.error,
          checkedAt: result.checkedAt,
          serverType: result.serverType || 'unknown'
        });
      }
    }
    
    state.clone.reachability = newMap;
  } catch (err) {
    console.warn('Failed to load clone URL reachability:', err);
  } finally {
    state.loading.reachability = false;
    state.clone.checkingReachability.clear();
  }
}

/**
 * Load fork information
 */
export async function loadForkInfo(
  state: RepoState
): Promise<void> {
  try {
    const data = await apiRequest<{
      isFork?: boolean;
      originalRepo?: {
        npub: string;
        repo: string;
      };
    }>(`/api/repos/${state.npub}/${state.repo}/forks`);
    
    if (data.isFork && data.originalRepo) {
      state.fork.info = {
        isFork: true,
        originalRepo: data.originalRepo
      };
    } else {
      state.fork.info = {
        isFork: false,
        originalRepo: null
      };
    }
  } catch (err) {
    console.error('Failed to load fork info:', err);
    state.fork.info = {
      isFork: false,
      originalRepo: null
    };
  }
}

/**
 * Load repository images (image and banner)
 */
export async function loadRepoImages(
  state: RepoState,
  repoOwnerPubkeyDerived: string | null,
  repoIsPrivate: boolean,
  pageData: any
): Promise<void> {
  try {
    // Get images from page data (loaded from announcement)
    if (typeof window === 'undefined') return;
    if (pageData?.image) {
      state.metadata.image = pageData.image;
      console.log('[Repo Images] Loaded image from pageData:', state.metadata.image);
    }
    if (pageData?.banner) {
      state.metadata.banner = pageData.banner;
      console.log('[Repo Images] Loaded banner from pageData:', state.metadata.banner);
    }

    // Also fetch from announcement directly as fallback (only if not private or user has access)
    if (!state.metadata.image && !state.metadata.banner && repoOwnerPubkeyDerived) {
      if (typeof window === 'undefined') return;
      
      // Check access for private repos
      if (repoIsPrivate) {
        const headers: Record<string, string> = {};
        if (state.user.pubkey) {
          try {
            const { nip19 } = await import('nostr-tools');
            const decoded = nip19.decode(state.user.pubkey);
            if (decoded.type === 'npub') {
              headers['X-User-Pubkey'] = decoded.data as string;
            } else {
              headers['X-User-Pubkey'] = state.user.pubkey;
            }
          } catch {
            headers['X-User-Pubkey'] = state.user.pubkey;
          }
        }
        
        const accessData = await apiRequest<{ canView?: boolean }>(`/api/repos/${state.npub}/${state.repo}/access`, {
          headers
        } as RequestInit);
        
        if (!accessData.canView) {
          // User doesn't have access, don't fetch images
          return;
        }
      }
      
      const { nip19 } = await import('nostr-tools');
      const decoded = nip19.decode(state.npub);
      if (decoded.type === 'npub') {
        const repoOwnerPubkey = decoded.data as string;
        const { NostrClient } = await import('$lib/services/nostr/nostr-client.js');
        const { DEFAULT_NOSTR_RELAYS } = await import('$lib/config.js');
        const client = new NostrClient(DEFAULT_NOSTR_RELAYS);
        const events = await client.fetchEvents([
          {
            kinds: [30617], // REPO_ANNOUNCEMENT
            authors: [repoOwnerPubkeyDerived],
            '#d': [state.repo],
            limit: 1
          }
        ]);

        if (events.length > 0) {
          const announcement = events[0];
          const imageTag = announcement.tags.find((t: string[]) => t[0] === 'image');
          const bannerTag = announcement.tags.find((t: string[]) => t[0] === 'banner');
          
          if (imageTag?.[1]) {
            state.metadata.image = imageTag[1];
            console.log('[Repo Images] Loaded image from announcement:', state.metadata.image);
          }
          if (bannerTag?.[1]) {
            state.metadata.banner = bannerTag[1];
            console.log('[Repo Images] Loaded banner from announcement:', state.metadata.banner);
          }
        } else {
          console.log('[Repo Images] No announcement found');
        }
      }
    }
    
    if (!state.metadata.image && !state.metadata.banner) {
      console.log('[Repo Images] No images found in announcement');
    }
  } catch (err) {
    console.error('Error loading repo images:', err);
  }
}

/**
 * Generate announcement file for repository
 */
export async function generateAnnouncementFileForRepo(
  state: RepoState,
  repoOwnerPubkeyDerived: string | null
): Promise<void> {
  if (!repoOwnerPubkeyDerived || !state.user.pubkeyHex) {
    state.error = 'Unable to generate announcement file: missing repository or user information';
    return;
  }

  try {
    // First, try to use the announcement from pageData (already loaded)
    let announcement: NostrEvent | null = null;
    
    if (state.pageData?.announcement) {
      announcement = state.pageData.announcement as NostrEvent;
    }
    
    // If not available in pageData, fetch from Nostr
    if (!announcement) {
      const { NostrClient } = await import('$lib/services/nostr/nostr-client.js');
      const { DEFAULT_NOSTR_RELAYS, DEFAULT_NOSTR_SEARCH_RELAYS } = await import('$lib/config.js');
      const { KIND } = await import('$lib/types/nostr.js');
      const nostrClient = new NostrClient([...new Set([...DEFAULT_NOSTR_RELAYS, ...DEFAULT_NOSTR_SEARCH_RELAYS])]);
      const events = await nostrClient.fetchEvents([
        {
          kinds: [KIND.REPO_ANNOUNCEMENT],
          authors: [repoOwnerPubkeyDerived],
          '#d': [state.repo],
          limit: 1
        }
      ]);

      if (events.length === 0) {
        state.error = 'Repository announcement not found. Please ensure the repository is registered on Nostr.';
        return;
      }

      announcement = events[0] as NostrEvent;
    }

    // Generate announcement event JSON (for download/reference)
    state.verification.fileContent = JSON.stringify(announcement, null, 2) + '\n';
    state.openDialog = 'verification';
  } catch (err) {
    console.error('Failed to generate announcement file:', err);
    state.error = `Failed to generate announcement file: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Copy verification file content to clipboard
 */
export function copyVerificationToClipboard(state: RepoState): void {
  if (!state.verification.fileContent) return;
  
  navigator.clipboard.writeText(state.verification.fileContent).then(() => {
    alert('Verification file content copied to clipboard!');
  }).catch((err) => {
    console.error('Failed to copy:', err);
    alert('Failed to copy to clipboard. Please select and copy manually.');
  });
}

/**
 * Save announcement to repository
 * Uses the existing verify endpoint which saves and commits the announcement
 */
export async function saveAnnouncementToRepo(
  state: RepoState,
  repoOwnerPubkeyDerived: string | null
): Promise<void> {
  if (!repoOwnerPubkeyDerived || !state.user.pubkeyHex) {
    state.error = 'Unable to save announcement: missing repository or user information';
    return;
  }

  if (!state.clone.isCloned) {
    state.error = 'Repository must be cloned first. Please clone the repository before saving the announcement.';
    return;
  }

  // Check if user is owner or maintainer
  if (!state.maintainers.isMaintainer && state.user.pubkeyHex !== repoOwnerPubkeyDerived) {
    state.error = 'Only repository owners and maintainers can save announcements.';
    return;
  }

  try {
    state.creating.announcement = true;
    state.error = null;

    // Use the existing verification endpoint which saves and commits the announcement
    const data = await apiRequest<{ message?: string; announcementId?: string }>(`/api/repos/${state.npub}/${state.repo}/verification`, {
      method: 'POST'
    } as RequestInit);

    // Close dialog and show success
    state.openDialog = null;
    alert(data.message || 'Announcement saved to repository successfully!');
    
    // Reload branches and files to show the new commit
    // The callbacks will be passed from the component
  } catch (err) {
    console.error('Failed to save announcement:', err);
    state.error = `Failed to save announcement: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    state.creating.announcement = false;
  }
}

/**
 * Download verification file
 */
export function downloadVerificationFile(state: RepoState): void {
  if (!state.verification.fileContent) return;
  
  const blob = new Blob([state.verification.fileContent], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'announcement-event.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Verify clone URL
 */
export async function verifyCloneUrl(
  state: RepoState,
  repoOwnerPubkeyDerived: string | null,
  callbacks: { checkVerification: () => Promise<void> }
): Promise<void> {
  if (!state.verification.selectedCloneUrl || !state.user.pubkey || !state.user.pubkeyHex) {
    state.error = 'Unable to verify: missing information';
    return;
  }

  if (!state.maintainers.isMaintainer && state.user.pubkeyHex !== repoOwnerPubkeyDerived) {
    state.error = 'Only repository owners and maintainers can verify clone URLs';
    return;
  }

  // selectedCloneUrl is already set when user selects it
  state.error = null;

  try {
    const data = await apiRequest<{ message?: string }>(`/api/repos/${state.npub}/${state.repo}/verification`, {
      method: 'POST'
    } as RequestInit);
    
    // Close dialog
    state.openDialog = null;
    state.verification.selectedCloneUrl = null;

    // Reload verification status after a short delay
    setTimeout(() => {
      callbacks.checkVerification().catch((err: unknown) => {
        console.warn('Failed to reload verification status:', err);
      });
    }, 1000);

    // Show success message
    alert(data.message || 'Repository verification initiated. The verification status will update shortly.');
  } catch (err) {
    state.error = err instanceof Error ? err.message : 'Failed to verify repository';
    console.error('Error verifying clone URL:', err);
  } finally {
    state.verification.selectedCloneUrl = null;
  }
}

/**
 * Delete repository announcement
 */
export async function deleteAnnouncement(
  state: RepoState,
  repoOwnerPubkeyDerived: string | null,
  announcementEventId: { value: string | null }
): Promise<void> {
  if (!state.user.pubkey || !state.user.pubkeyHex) {
    alert('Please connect your NIP-07 extension');
    return;
  }

  if (!repoOwnerPubkeyDerived || state.user.pubkeyHex !== repoOwnerPubkeyDerived) {
    alert('Only the repository owner can delete the announcement');
    return;
  }

  // First confirmation
  if (!confirm('WARNING: Are you sure you want to delete this repository announcement?\n\nThis will permanently delete the repository announcement from Nostr relays. This action CANNOT be undone.\n\nClick OK to continue, or Cancel to abort.')) {
    return;
  }

  // Second confirmation for critical operation
  if (!confirm('FINAL CONFIRMATION: This will permanently delete the repository announcement.\n\nAre you absolutely certain you want to proceed?\n\nThis action CANNOT be undone.')) {
    return;
  }

  state.creating.announcement = true;
  state.error = null;

  try {
    // Fetch the repository announcement to get its event ID
    const { NostrClient } = await import('$lib/services/nostr/nostr-client.js');
    const { DEFAULT_NOSTR_RELAYS, DEFAULT_NOSTR_SEARCH_RELAYS, combineRelays } = await import('$lib/config.js');
    const { getUserRelays } = await import('$lib/services/nostr/user-relays.js');
    const { signEventWithNIP07 } = await import('$lib/services/nostr/nip07-signer.js');
    const { KIND } = await import('$lib/types/nostr.js');
    const nostrClient = new NostrClient([...new Set([...DEFAULT_NOSTR_RELAYS, ...DEFAULT_NOSTR_SEARCH_RELAYS])]);
    const events = await nostrClient.fetchEvents([
      {
        kinds: [KIND.REPO_ANNOUNCEMENT],
        authors: [repoOwnerPubkeyDerived],
        '#d': [state.repo],
        limit: 1
      }
    ]);

    if (events.length === 0) {
      throw new Error('Repository announcement not found');
    }

    const announcement = events[0];
    announcementEventId.value = announcement.id;

    // Get user relays
    const { outbox } = await getUserRelays(state.user.pubkeyHex, nostrClient);
    const combinedRelays = combineRelays(outbox);

    // Create deletion request (NIP-09)
    const deletionRequestTemplate: Omit<NostrEvent, 'sig' | 'id'> = {
      kind: KIND.DELETION_REQUEST,
      pubkey: state.user.pubkeyHex,
      created_at: Math.floor(Date.now() / 1000),
      content: `Requesting deletion of repository announcement for ${state.repo}`,
      tags: [
        ['e', announcement.id], // Reference to the announcement event
        ['a', `${KIND.REPO_ANNOUNCEMENT}:${repoOwnerPubkeyDerived}:${state.repo}`], // Repository address
        ['k', KIND.REPO_ANNOUNCEMENT.toString()] // Kind of event being deleted
      ]
    };

    // Sign with NIP-07
    const signedDeletionRequest = await signEventWithNIP07(deletionRequestTemplate);

    // Publish to relays
    const publishResult = await nostrClient.publishEvent(signedDeletionRequest, combinedRelays);

    if (publishResult.success.length > 0) {
      alert(`Deletion request published successfully to ${publishResult.success.length} relay(s).`);
    } else {
      throw new Error(`Failed to publish deletion request to any relay. Errors: ${publishResult.failed.map(f => `${f.relay}: ${f.error}`).join('; ')}`);
    }
  } catch (err) {
    console.error('Failed to delete announcement:', err);
    state.error = err instanceof Error ? err.message : 'Failed to send deletion request';
    alert(state.error);
  } finally {
    state.creating.announcement = false;
  }
}

/**
 * Copy event ID to clipboard
 */
export async function copyEventId(
  state: RepoState,
  repoOwnerPubkeyDerived: string | null
): Promise<void> {
  if (!state.metadata.address || !repoOwnerPubkeyDerived) {
    alert('Repository address not available');
    return;
  }

  try {
    const { nip19 } = await import('nostr-tools');
    const { KIND } = await import('$lib/types/nostr.js');
    
    // Create naddr (NIP-19 address) for the repository
    const naddr = nip19.naddrEncode({
      kind: KIND.REPO_ANNOUNCEMENT,
      pubkey: repoOwnerPubkeyDerived,
      identifier: state.repo,
      relays: []
    });

    // Try to use the Clipboard API
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(naddr);
    } else {
      // Fallback: use execCommand for older browsers or if clipboard API fails
      const textArea = document.createElement('textarea');
      textArea.value = naddr;
      textArea.style.position = 'fixed';
      textArea.style.opacity = '0';
      document.body.appendChild(textArea);
      textArea.select();
      try {
        document.execCommand('copy');
        textArea.remove();
      } catch (execErr) {
        textArea.remove();
        throw new Error('Failed to copy to clipboard. Please copy manually: ' + naddr);
      }
    }
    
    // Show message with naddr
    alert(`Event ID copied to clipboard!\n\nnaddr (repository address):\n${naddr}`);
  } catch (err) {
    console.error('Failed to copy event ID:', err);
    alert(`Failed to copy event ID: ${err instanceof Error ? err.message : String(err)}`);
  }
}
