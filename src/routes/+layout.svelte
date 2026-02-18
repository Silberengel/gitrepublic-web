<script lang="ts">
  import '../app.css';
  import { onMount, setContext } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import Footer from '$lib/components/Footer.svelte';
  import NavBar from '$lib/components/NavBar.svelte';
  import type { Snippet } from 'svelte';
  import { getPublicKeyWithNIP07, isNIP07Available } from '$lib/services/nostr/nip07-signer.js';
  import { determineUserLevel, decodePubkey } from '$lib/services/nostr/user-level-service.js';
  import { userStore } from '$lib/stores/user-store.js';
  import { isSessionExpired, updateActivity, clearActivity } from '$lib/services/activity-tracker.js';

  // Accept children as a snippet prop (Svelte 5)
  let { children }: { children: Snippet } = $props();

  // Theme management - default to dark
  let theme: 'light' | 'dark' = 'dark';
  
  // User level checking state
  let checkingUserLevel = $state(false);

  onMount(() => {
    // Only run client-side code
    if (typeof window === 'undefined') return;
    
    // Check for saved theme preference or default to dark
    const savedTheme = localStorage.getItem('theme') as 'light' | 'dark' | null;
    if (savedTheme === 'light' || savedTheme === 'dark') {
      theme = savedTheme;
    } else {
      // Default to dark
      theme = 'dark';
    }
    applyTheme();

    // Watch for system theme changes (only if user hasn't set a preference)
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (!localStorage.getItem('theme')) {
        theme = e.matches ? 'dark' : 'light';
        applyTheme();
      }
    });
    
    // Check for session expiry (24 hours)
    if (isSessionExpired()) {
      // Session expired - logout user
      userStore.reset();
      clearActivity();
      console.log('Session expired after 24 hours of inactivity');
    } else {
      // Update activity on mount
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
    
    // Set up periodic session expiry check (every 5 minutes)
    const expiryCheckInterval = setInterval(() => {
      if (isSessionExpired()) {
        userStore.reset();
        clearActivity();
        console.log('Session expired after 24 hours of inactivity');
        // Optionally redirect to home page
        if ($page.url.pathname !== '/') {
          goto('/');
        }
      }
    }, 5 * 60 * 1000); // Check every 5 minutes
    
    return () => {
      clearInterval(expiryCheckInterval);
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
    
    checkingUserLevel = true;
    userStore.setChecking(true);
    
    try {
      let userPubkey: string | null = null;
      let userPubkeyHex: string | null = null;
      
      // Try to get user pubkey if NIP-07 is available
      if (isNIP07Available()) {
        try {
          userPubkey = await getPublicKeyWithNIP07();
          userPubkeyHex = decodePubkey(userPubkey);
        } catch (err) {
          console.warn('Failed to get user pubkey:', err);
        }
      }
      
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
      if (levelResult.userPubkey) {
        updateActivity();
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

  function applyTheme() {
    if (theme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    localStorage.setItem('theme', theme);
  }

  function toggleTheme() {
    theme = theme === 'light' ? 'dark' : 'light';
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
</script>

{#if !isSplashPage}
  <NavBar />
{/if}

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
