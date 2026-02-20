<script lang="ts">
  import '../app.css';
  import { onMount, setContext } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import Footer from '$lib/components/Footer.svelte';
  import NavBar from '$lib/components/NavBar.svelte';
  import TransferNotification from '$lib/components/TransferNotification.svelte';
  import type { Snippet } from 'svelte';
  import { getPublicKeyWithNIP07, isNIP07Available } from '$lib/services/nostr/nip07-signer.js';
  import { determineUserLevel, decodePubkey } from '$lib/services/nostr/user-level-service.js';
  import { userStore } from '$lib/stores/user-store.js';
  import { updateActivity } from '$lib/services/activity-tracker.js';

  // Accept children as a snippet prop (Svelte 5)
  let { children }: { children: Snippet } = $props();

  // Theme management - default to gitrepublic-dark (purple)
  let theme: 'gitrepublic-light' | 'gitrepublic-dark' | 'gitrepublic-black' = 'gitrepublic-dark';
  
  // User level checking state
  let checkingUserLevel = $state(false);

  // Transfer notification state
  type PendingTransfer = {
    eventId: string;
    fromPubkey: string;
    toPubkey: string;
    repoTag: string;
    repoName: string;
    originalOwner: string;
    timestamp: number;
    createdAt: string;
    event: any;
  };
  let pendingTransfers = $state<PendingTransfer[]>([]);
  let dismissedTransfers = $state<Set<string>>(new Set());

  onMount(() => {
    // Only run client-side code
    if (typeof window === 'undefined') return;
    
    // Check for saved theme preference or default to gitrepublic-dark
    const savedTheme = localStorage.getItem('theme') as 'gitrepublic-light' | 'gitrepublic-dark' | 'gitrepublic-black' | null;
    if (savedTheme === 'gitrepublic-light' || savedTheme === 'gitrepublic-dark' || savedTheme === 'gitrepublic-black') {
      theme = savedTheme;
    } else {
      // Default to gitrepublic-dark (purple)
      theme = 'gitrepublic-dark';
    }
    applyTheme();
    
    // Update activity on mount (if user is logged in)
    // Session expiry is handled by user store initialization and NavBar
    const currentState = $userStore;
    if (currentState.userPubkey && currentState.userPubkeyHex) {
      updateActivity();
    }
    
    // Check user level if not on splash page
    // Only check if user store is not already initialized with a logged-in user
    if ($page.url.pathname !== '/') {
      const currentState = $userStore;
      // Only check if we don't have a user or if user level is strictly_rate_limited
      if (!currentState.userPubkey || currentState.userLevel === 'strictly_rate_limited') {
        checkUserLevel();
      }
    }
    
    // Listen for pending transfers events from login functions
    const handlePendingTransfersEvent = (event: Event) => {
      const customEvent = event as CustomEvent;
      if (customEvent.detail?.transfers) {
        // Filter out dismissed transfers
        pendingTransfers = customEvent.detail.transfers.filter(
          (t: { eventId: string }) => !dismissedTransfers.has(t.eventId)
        );
      }
    };
    
    window.addEventListener('pendingTransfers', handlePendingTransfersEvent);
    
    // Session expiry checking is handled by:
    // 1. User store initialization (checks on load)
    // 2. NavBar component (checks on mount and periodically)
    // 3. Splash page (+page.svelte) (checks on mount)
    // No need for redundant checks here
    
    return () => {
      window.removeEventListener('pendingTransfers', handlePendingTransfersEvent);
    };
  });
  
  async function checkUserLevel() {
    // Only run client-side
    if (typeof window === 'undefined') return;
    
    // Skip if already checking or if user store is already set
    const currentState = $userStore;
    if (checkingUserLevel || (currentState.userPubkey && currentState.userLevel !== 'strictly_rate_limited')) {
      return;
    }
    
    // Only check user level if user has explicitly logged in (has pubkey in store)
    // Don't automatically get pubkey from NIP-07 - that should only happen on explicit login
    if (!currentState.userPubkey) {
      // User not logged in - set to strictly rate limited without checking
      userStore.setUser(null, null, 'strictly_rate_limited', null);
      return;
    }
    
    checkingUserLevel = true;
    userStore.setChecking(true);
    
    try {
      // Use pubkey from store (user has explicitly logged in)
      const userPubkey = currentState.userPubkey;
      const userPubkeyHex = currentState.userPubkeyHex;
      
      // Determine user level
      const levelResult = await determineUserLevel(userPubkey, userPubkeyHex);
      
      // Update user store
      userStore.setUser(
        levelResult.userPubkey,
        levelResult.userPubkeyHex,
        levelResult.level,
        levelResult.error || null
      );
      
      // Update activity if user is logged in
      if (levelResult.userPubkey && levelResult.userPubkeyHex) {
        updateActivity();
        // Check for pending transfers
        checkPendingTransfers(levelResult.userPubkeyHex);
      }
    } catch (err) {
      console.error('Failed to check user level:', err);
      // Set to strictly rate limited on error
      userStore.setUser(null, null, 'strictly_rate_limited', 'Failed to check user level');
    } finally {
      checkingUserLevel = false;
      userStore.setChecking(false);
    }
  }

  async function checkPendingTransfers(userPubkeyHex: string) {
    try {
      const response = await fetch('/api/transfers/pending', {
        headers: {
          'X-User-Pubkey': userPubkeyHex
        }
      });

      if (response.ok) {
        const data = await response.json();
        if (data.pendingTransfers && data.pendingTransfers.length > 0) {
          // Filter out dismissed transfers
          pendingTransfers = data.pendingTransfers.filter(
            (t: { eventId: string }) => !dismissedTransfers.has(t.eventId)
          );
        }
      }
    } catch (err) {
      console.error('Failed to check for pending transfers:', err);
    }
  }

  function dismissTransfer(eventId: string) {
    dismissedTransfers.add(eventId);
    pendingTransfers = pendingTransfers.filter(t => t.eventId !== eventId);
  }

  function applyTheme() {
    // Remove all theme attributes first
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-theme-light');
    document.documentElement.removeAttribute('data-theme-black');
    
    // Apply the selected theme
    if (theme === 'gitrepublic-light') {
      document.documentElement.setAttribute('data-theme', 'light');
    } else if (theme === 'gitrepublic-dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else if (theme === 'gitrepublic-black') {
      document.documentElement.setAttribute('data-theme', 'black');
    }
    localStorage.setItem('theme', theme);
  }

  function toggleTheme() {
    // Cycle through themes: gitrepublic-dark -> gitrepublic-light -> gitrepublic-black -> gitrepublic-dark
    if (theme === 'gitrepublic-dark') {
      theme = 'gitrepublic-light';
    } else if (theme === 'gitrepublic-light') {
      theme = 'gitrepublic-black';
    } else {
      theme = 'gitrepublic-dark';
    }
    applyTheme();
  }

  // Provide theme context to child components
  setContext('theme', {
    get theme() { return { value: theme }; },
    toggleTheme
  });

  // Hide nav bar and footer on splash page (root path)
  const isSplashPage = $derived($page.url.pathname === '/');
  
  // Subscribe to user store
  const userState = $derived($userStore);

  // Check for transfers when user logs in
  $effect(() => {
    const currentUser = $userStore;
    if (currentUser.userPubkeyHex && !checkingUserLevel) {
      checkPendingTransfers(currentUser.userPubkeyHex);
    } else if (!currentUser.userPubkeyHex) {
      // Clear transfers when user logs out
      pendingTransfers = [];
      dismissedTransfers.clear();
    }
  });

</script>

{#if !isSplashPage}
  <NavBar />
{/if}

<!-- Transfer notifications -->
{#each pendingTransfers as transfer (transfer.eventId)}
  <TransferNotification {transfer} on:dismiss={(e) => dismissTransfer(e.detail.eventId)} />
{/each}

{#if !isSplashPage && checkingUserLevel}
  <div class="user-level-check">
    <div class="check-message">
      <p>Checking user access level...</p>
      <div class="spinner"></div>
    </div>
  </div>
{:else}
  {@render children()}
{/if}

{#if !isSplashPage}
  <Footer />
{/if}

<style>
  .user-level-check {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 50vh;
    padding: 2rem;
  }
  
  .check-message {
    text-align: center;
  }
  
  .check-message p {
    margin-bottom: 1rem;
    color: var(--text-primary, #1a1a1a);
    font-size: 1.1rem;
  }
  
  .spinner {
    border: 3px solid var(--bg-secondary, #e8e8e8);
    border-top: 3px solid var(--accent, #007bff);
    border-radius: 50%;
    width: 40px;
    height: 40px;
    animation: spin 1s linear infinite;
    margin: 0 auto;
  }
  
  @keyframes spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
  }
  
  @media (prefers-color-scheme: dark) {
    .check-message p {
      color: var(--text-primary, #f5f5f5);
    }
    
    .spinner {
      border-color: var(--bg-secondary, #2d2d2d);
      border-top-color: var(--accent, #007bff);
    }
  }
</style>
