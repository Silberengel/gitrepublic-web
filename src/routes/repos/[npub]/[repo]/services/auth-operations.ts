/**
 * Authentication operations service
 * Handles user authentication and login
 */

import type { RepoState } from '../stores/repo-state.js';
import { userStore } from '$lib/stores/user-store.js';
import { getPublicKeyWithNIP07 } from '$lib/services/nostr/nip07-signer.js';
import { get } from 'svelte/store';

/**
 * Check authentication status
 */
export async function checkAuth(state: RepoState): Promise<void> {
  // Check userStore first
  const currentUser = get(userStore);
  if (currentUser.userPubkey && currentUser.userPubkeyHex) {
    state.user.pubkey = currentUser.userPubkey;
    state.user.pubkeyHex = currentUser.userPubkeyHex;
    // Recheck maintainer status and bookmark status after auth
    // These will be called by useUserStoreEffect hook
  }
}

/**
 * Login with NIP-07
 */
export async function login(
  state: RepoState,
  callbacks: {
    checkMaintainerStatus: () => Promise<void>;
    loadBookmarkStatus: () => Promise<void>;
  }
): Promise<void> {
  // Check userStore first
  const currentUser = get(userStore);
  if (currentUser.userPubkey && currentUser.userPubkeyHex) {
    state.user.pubkey = currentUser.userPubkey;
    state.user.pubkeyHex = currentUser.userPubkeyHex;
    // Recheck maintainer status and bookmark status after auth
    await callbacks.checkMaintainerStatus();
    await callbacks.loadBookmarkStatus();
    return;
  }
  
  try {
    // Get public key from NIP-07 extension
    const pubkey = await getPublicKeyWithNIP07();
    if (!pubkey) {
      state.error = 'Failed to get public key from NIP-07 extension';
      return;
    }
    
    state.user.pubkey = pubkey;
    
    // Convert npub to hex if needed
    let pubkeyHex: string;
    if (pubkey.startsWith('npub')) {
      try {
        const { nip19 } = await import('nostr-tools');
        const decoded = nip19.decode(pubkey);
        if (decoded.type === 'npub') {
          pubkeyHex = decoded.data as string;
        } else {
          state.error = 'Invalid public key format';
          return;
        }
      } catch {
        state.error = 'Invalid public key format';
        return;
      }
    } else {
      pubkeyHex = pubkey;
    }
    
    state.user.pubkeyHex = pubkeyHex;
    
    // Check write access and update user store
    const { determineUserLevel } = await import('$lib/services/nostr/user-level-service.js');
    const levelResult = await determineUserLevel(state.user.pubkey, state.user.pubkeyHex);
    
    // Update user store with write access level
    userStore.setUser(
      levelResult.userPubkey,
      levelResult.userPubkeyHex,
      levelResult.level,
      levelResult.error || null
    );
    
    // Update activity tracking
    const { updateActivity } = await import('$lib/services/activity-tracker.js');
    updateActivity();
    
    // Check for pending transfer events
    if (state.user.pubkeyHex) {
      try {
        const response = await fetch('/api/transfers/pending', {
          headers: {
            'X-User-Pubkey': state.user.pubkeyHex
          }
        });
        if (response.ok) {
          const data = await response.json();
          if (data.pendingTransfers && data.pendingTransfers.length > 0) {
            window.dispatchEvent(new CustomEvent('pendingTransfers', { 
              detail: { transfers: data.pendingTransfers } 
            }));
          }
        }
      } catch (err) {
        console.error('Failed to check for pending transfers:', err);
      }
    }
    
    // Re-check maintainer status and bookmark status after login
    await callbacks.checkMaintainerStatus();
    await callbacks.loadBookmarkStatus();
  } catch (err) {
    state.error = err instanceof Error ? err.message : 'Failed to connect';
    console.error('Login error:', err);
  }
}
