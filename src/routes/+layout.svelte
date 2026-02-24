<script lang="ts">
  import '../app.css';
  import { onMount, onDestroy, setContext } from 'svelte';
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
  import { settingsStore } from '$lib/services/settings-store.js';

  // Accept children as a snippet prop (Svelte 5)
  let { children }: { children: Snippet } = $props();

  // Component mount tracking to prevent state updates after destruction
  let isMounted = $state(true);
  
  // Store cleanup references
  let handlePendingTransfersEvent: ((event: Event) => void) | null = null;
  let handleThemeChanged: ((event: Event) => void) | null = null;

  // Theme management - default to gitrepublic-dark (purple)
  let theme = $state<'gitrepublic-light' | 'gitrepublic-dark' | 'gitrepublic-black'>('gitrepublic-dark');
  
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

  // Load theme on mount and watch for changes
  onMount(() => {
    // Only run client-side code
    if (typeof window === 'undefined' || !isMounted) return;
    
    // Load theme from settings store (async)
    (async () => {
      if (!isMounted) return;
      try {
        const settings = await settingsStore.getSettings();
        if (isMounted) {
          theme = settings.theme;
          themeLoaded = true;
          applyTheme(theme);
          // Also sync to localStorage for app.html flash prevention
          localStorage.setItem('theme', theme);
        }
      } catch (err) {
        if (!isMounted) return;
        console.warn('Failed to load theme from settings, using default:', err);
        // Fallback to localStorage for migration
        try {
          const savedTheme = localStorage.getItem('theme') as 'gitrepublic-light' | 'gitrepublic-dark' | 'gitrepublic-black' | null;
          if (savedTheme === 'gitrepublic-light' || savedTheme === 'gitrepublic-dark' || savedTheme === 'gitrepublic-black') {
            if (isMounted) {
              theme = savedTheme;
              themeLoaded = true;
              applyTheme(theme);
              // Migrate to settings store
              settingsStore.setSetting('theme', theme).catch(console.error);
            }
          } else if (isMounted) {
            theme = 'gitrepublic-dark';
            themeLoaded = true;
            applyTheme(theme);
            localStorage.setItem('theme', theme);
          }
        } catch {
          // Ignore localStorage errors
        }
      }
    })();
    
    // Update activity on mount (if user is logged in)
    // Session expiry is handled by user store initialization and NavBar
    try {
      const currentState = $userStore;
      if (currentState && currentState.userPubkey && currentState.userPubkeyHex && isMounted) {
        updateActivity();
      }
    } catch (err) {
      if (isMounted) {
        console.warn('Failed to update activity on mount:', err);
      }
    }
    
    // Check user level if not on splash page
    // Only check if user store is not already initialized with a logged-in user
    // Guard against SSR - $page store can only be accessed in component context
    if (typeof window !== 'undefined' && isMounted) {
      try {
        const pageUrl = $page.url;
        if (pageUrl && pageUrl.pathname !== '/') {
          const currentState = $userStore;
          // Only check if we don't have a user or if user level is strictly_rate_limited
          if (isMounted && (!currentState.userPubkey || currentState.userLevel === 'strictly_rate_limited')) {
            checkUserLevel();
          }
        }
      } catch (err) {
        // Ignore errors accessing $page during SSR or destruction
        if (isMounted) {
          console.warn('Failed to check user level on mount:', err);
        }
      }
    }
    
    // Listen for pending transfers events from login functions
    handlePendingTransfersEvent = (event: Event) => {
      if (!isMounted) return;
      try {
        const customEvent = event as CustomEvent;
        if (customEvent.detail?.transfers && isMounted) {
          // Filter out dismissed transfers
          pendingTransfers = customEvent.detail.transfers.filter(
            (t: { eventId: string }) => !dismissedTransfers.has(t.eventId)
          );
        }
      } catch (err) {
        // Ignore errors during destruction
        if (isMounted) {
          console.warn('Pending transfers event handler error:', err);
        }
      }
    };
    
    if (handlePendingTransfersEvent) {
      window.addEventListener('pendingTransfers', handlePendingTransfersEvent);
    }
    
    // Listen for theme changes from SettingsModal
    handleThemeChanged = (event: Event) => {
      if (!isMounted) return;
      try {
        const customEvent = event as CustomEvent<{ theme: 'gitrepublic-light' | 'gitrepublic-dark' | 'gitrepublic-black' }>;
        if (customEvent.detail?.theme && isMounted) {
          theme = customEvent.detail.theme;
          // Sync to localStorage for app.html flash prevention
          localStorage.setItem('theme', theme);
          // Theme will be applied via $effect
        }
      } catch (err) {
        // Ignore errors during destruction
        if (isMounted) {
          console.warn('Theme changed event handler error:', err);
        }
      }
    };
    
    if (handleThemeChanged) {
      window.addEventListener('themeChanged', handleThemeChanged);
    }
    
    // Session expiry checking is handled by:
    // 1. User store initialization (checks on load)
    // 2. NavBar component (checks on mount and periodically)
    // 3. Splash page (+page.svelte) (checks on mount)
    // No need for redundant checks here
  });
  
  onDestroy(() => {
    // Mark component as unmounted first
    isMounted = false;
    
    // Clean up event listeners
    try {
      if (handlePendingTransfersEvent) {
        window.removeEventListener('pendingTransfers', handlePendingTransfersEvent);
        handlePendingTransfersEvent = null;
      }
    } catch (err) {
      // Ignore errors during cleanup
    }
    
    try {
      if (handleThemeChanged) {
        window.removeEventListener('themeChanged', handleThemeChanged);
        handleThemeChanged = null;
      }
    } catch (err) {
      // Ignore errors during cleanup
    }
  });
  
  async function checkUserLevel() {
    // Only run client-side
    if (typeof window === 'undefined' || !isMounted) return;
    
    // Skip if already checking or if user store is already set
    try {
      const currentState = $userStore;
      if (!currentState || !isMounted) return;
      
      if (checkingUserLevel || (currentState.userPubkey && currentState.userLevel !== 'strictly_rate_limited')) {
        return;
      }
      
      // Only check user level if user has explicitly logged in (has pubkey in store)
      // Don't automatically get pubkey from NIP-07 - that should only happen on explicit login
      if (!currentState.userPubkey) {
        // User not logged in - set to strictly rate limited without checking
        if (isMounted) {
          userStore.setUser(null, null, 'strictly_rate_limited', null);
        }
        return;
      }
      
      if (!isMounted) return;
      
      checkingUserLevel = true;
      userStore.setChecking(true);
      
      try {
        // Use pubkey from store (user has explicitly logged in)
        const userPubkey = currentState.userPubkey;
        const userPubkeyHex = currentState.userPubkeyHex;
        
        if (!isMounted) {
          checkingUserLevel = false;
          userStore.setChecking(false);
          return;
        }
        
        // Determine user level
        const levelResult = await determineUserLevel(userPubkey, userPubkeyHex);
        
        if (!isMounted) {
          checkingUserLevel = false;
          userStore.setChecking(false);
          return;
        }
        
        // Update user store
        userStore.setUser(
          levelResult.userPubkey,
          levelResult.userPubkeyHex,
          levelResult.level,
          levelResult.error || null
        );
        
        // Update activity if user is logged in
        if (levelResult.userPubkey && levelResult.userPubkeyHex && isMounted) {
          updateActivity();
          // Check for pending transfers
          checkPendingTransfers(levelResult.userPubkeyHex);
        }
      } catch (err) {
        if (isMounted) {
          console.error('Failed to check user level:', err);
          // Set to strictly rate limited on error
          userStore.setUser(null, null, 'strictly_rate_limited', 'Failed to check user level');
        }
      } finally {
        if (isMounted) {
          checkingUserLevel = false;
          userStore.setChecking(false);
        }
      }
    } catch (err) {
      // Ignore errors during destruction
      if (isMounted) {
        console.warn('User level check error:', err);
      }
    }
  }

  async function checkPendingTransfers(userPubkeyHex: string) {
    if (!isMounted) return;
    
    try {
      // Add timeout to prevent hanging
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
      
      const response = await fetch('/api/transfers/pending', {
        headers: {
          'X-User-Pubkey': userPubkeyHex
        },
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (response.ok && isMounted) {
        const data = await response.json();
        if (data.pendingTransfers && data.pendingTransfers.length > 0 && isMounted) {
          // Filter out dismissed transfers
          pendingTransfers = data.pendingTransfers.filter(
            (t: { eventId: string }) => !dismissedTransfers.has(t.eventId)
          );
        }
      }
    } catch (err) {
      // Only log if it's not an abort (timeout) and component is still mounted
      if (isMounted && err instanceof Error && err.name !== 'AbortError') {
        console.error('Failed to check for pending transfers:', err);
      }
      // Silently ignore timeouts - they're expected if the server is slow
    }
  }

  function dismissTransfer(eventId: string) {
    dismissedTransfers.add(eventId);
    pendingTransfers = pendingTransfers.filter(t => t.eventId !== eventId);
  }

  function applyTheme(newTheme?: 'gitrepublic-light' | 'gitrepublic-dark' | 'gitrepublic-black') {
    const themeToApply = newTheme || theme;
    // Only run client-side
    if (typeof window === 'undefined') return;
    
    // Remove all theme attributes first
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-theme-light');
    document.documentElement.removeAttribute('data-theme-black');
    
    // Apply the selected theme
    if (themeToApply === 'gitrepublic-light') {
      document.documentElement.setAttribute('data-theme', 'light');
    } else if (themeToApply === 'gitrepublic-dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else if (themeToApply === 'gitrepublic-black') {
      document.documentElement.setAttribute('data-theme', 'black');
    }
    
    // Save to settings store (async, don't await)
    if (newTheme) {
      settingsStore.setSetting('theme', themeToApply).catch(console.error);
    }
  }
  
  // Watch for theme changes and apply them (but only after initial load)
  let themeLoaded = $state(false);
  $effect(() => {
    if (typeof window !== 'undefined' && themeLoaded && isMounted) {
      applyTheme(theme);
    }
  });

  function toggleTheme() {
    // Cycle through themes: gitrepublic-dark -> gitrepublic-light -> gitrepublic-black -> gitrepublic-dark
    if (theme === 'gitrepublic-dark') {
      theme = 'gitrepublic-light';
    } else if (theme === 'gitrepublic-light') {
      theme = 'gitrepublic-black';
    } else {
      theme = 'gitrepublic-dark';
    }
    // Theme change will be applied via $effect
  }

  // Provide theme context to child components
  // Guard against SSR issues where setContext might be called outside component initialization
  try {
    setContext('theme', {
      get theme() { return { value: theme }; },
      toggleTheme
    });
  } catch (err) {
    // Silently ignore setContext errors during SSR or if called outside component initialization
    // This can happen during server-side rendering or in certain edge cases
    if (typeof window !== 'undefined') {
      // Only log in browser to avoid cluttering SSR logs
      console.warn('Failed to set theme context:', err);
    }
  }

  // Hide nav bar and footer on splash page (root path)
  // Use state that gets updated on mount to avoid SSR issues with $page store
  let isSplashPage = $state(false);
  
  // Update splash page state on mount (client-side only)
  $effect(() => {
    if (typeof window !== 'undefined' && isMounted) {
      try {
        const pageUrl = $page.url;
        if (pageUrl && isMounted) {
          isSplashPage = pageUrl.pathname === '/';
        }
      } catch (err) {
        // Ignore errors accessing $page during SSR or destruction
        if (isMounted) {
          console.warn('Failed to check splash page state:', err);
        }
      }
    }
  });
  
  // Subscribe to user store
  const userState = $derived($userStore);

  // Check for transfers when user logs in
  $effect(() => {
    if (!isMounted || typeof window === 'undefined') return;
    try {
      const currentUser = $userStore;
      if (!currentUser || !isMounted) return;
      
      if (currentUser.userPubkeyHex && !checkingUserLevel && isMounted) {
        checkPendingTransfers(currentUser.userPubkeyHex);
      } else if (!currentUser.userPubkeyHex && isMounted) {
        // Clear transfers when user logs out
        pendingTransfers = [];
        dismissedTransfers.clear();
      }
    } catch (err) {
      // Ignore errors during destruction
      if (isMounted) {
        console.warn('Transfer check effect error:', err);
      }
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
