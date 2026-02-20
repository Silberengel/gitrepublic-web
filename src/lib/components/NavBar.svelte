<script lang="ts">
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { getPublicKeyWithNIP07, isNIP07Available } from '../services/nostr/nip07-signer.js';
  import { nip19 } from 'nostr-tools';
  import SettingsButton from './SettingsButton.svelte';
  import UserBadge from './UserBadge.svelte';
  import { onMount } from 'svelte';
  import { userStore } from '../stores/user-store.js';
  import { clearActivity, updateActivity, isSessionExpired } from '../services/activity-tracker.js';
  import { determineUserLevel, decodePubkey } from '../services/nostr/user-level-service.js';

  let userPubkey = $state<string | null>(null);
  let mobileMenuOpen = $state(false);

  // Sync with userStore changes
  $effect(() => {
    const currentUser = $userStore;
    if (currentUser.userPubkey && currentUser.userPubkeyHex) {
      // Check if session expired
      if (isSessionExpired()) {
        userStore.reset();
        userPubkey = null;
      } else {
        userPubkey = currentUser.userPubkey;
        updateActivity();
      }
    } else {
      userPubkey = null;
    }
  });

  onMount(() => {
    // User store already checks session expiry on initialization
    // Just restore state from store (which loads from localStorage)
    const currentState = $userStore;
    if (currentState.userPubkey && currentState.userPubkeyHex) {
      // User is logged in - restore state (already synced by $effect, but ensure it's set)
      userPubkey = currentState.userPubkey;
      // Update activity to extend session
      updateActivity();
    } else {
      // User not logged in - check auth
      checkAuth();
    }
    
    // Set up activity tracking for user interactions
    const updateActivityOnInteraction = () => {
      if (userPubkey) {
        updateActivity();
      }
    };
    
    // Track various user interactions
    document.addEventListener('click', updateActivityOnInteraction, { passive: true });
    document.addEventListener('keydown', updateActivityOnInteraction, { passive: true });
    document.addEventListener('scroll', updateActivityOnInteraction, { passive: true });
    
    // Check session expiry periodically (every 5 minutes)
    const expiryCheckInterval = setInterval(() => {
      if (isSessionExpired()) {
        // Session expired - logout user
        userStore.reset();
        userPubkey = null;
        clearInterval(expiryCheckInterval);
      }
    }, 5 * 60 * 1000); // Check every 5 minutes
    
    return () => {
      document.removeEventListener('click', updateActivityOnInteraction);
      document.removeEventListener('keydown', updateActivityOnInteraction);
      document.removeEventListener('scroll', updateActivityOnInteraction);
      clearInterval(expiryCheckInterval);
    };
  });

  function toggleMobileMenu() {
    mobileMenuOpen = !mobileMenuOpen;
  }

  function closeMobileMenu() {
    mobileMenuOpen = false;
  }

  async function checkAuth() {
    // Don't check auth if user store indicates user is logged out
    const currentState = $userStore;
    if (!currentState.userPubkey) {
      userPubkey = null;
      return;
    }
    
    try {
      if (isNIP07Available()) {
        userPubkey = await getPublicKeyWithNIP07();
      }
    } catch (err) {
      console.log('NIP-07 not available or user not connected');
      userPubkey = null;
    }
  }

  async function login() {
    if (!isNIP07Available()) {
      alert('Nostr extension not found. Please install a Nostr extension like nos2x or Alby to login.');
      return;
    }

    try {
      // Get public key directly from NIP-07
      let pubkey: string;
      try {
        pubkey = await getPublicKeyWithNIP07();
        if (!pubkey) {
          throw new Error('No public key returned from extension');
        }
      } catch (err) {
        console.error('Failed to get public key from NIP-07:', err);
        alert('Failed to connect to Nostr extension. Please make sure your extension is unlocked and try again.');
        return;
      }

      // Convert npub to hex for API calls
      let pubkeyHex: string;
      if (/^[0-9a-f]{64}$/i.test(pubkey)) {
        // Already hex format
        pubkeyHex = pubkey.toLowerCase();
        userPubkey = pubkey;
      } else {
        // Try to decode as npub
        try {
          const decoded = nip19.decode(pubkey);
          if (decoded.type === 'npub') {
            pubkeyHex = decoded.data as string;
            userPubkey = pubkey; // Keep original npub format
          } else {
            throw new Error('Invalid pubkey format');
          }
        } catch (decodeErr) {
          console.error('Failed to decode pubkey:', decodeErr);
          alert('Invalid public key format. Please try again.');
          return;
        }
      }

      // Determine user level (checks relay write access)
      const levelResult = await determineUserLevel(userPubkey, pubkeyHex);
      
      // Update user store
      userStore.setUser(
        levelResult.userPubkey,
        levelResult.userPubkeyHex,
        levelResult.level,
        levelResult.error || null
      );
      
      // Update activity tracking on successful login
      updateActivity();
      
      // Check for pending transfer events
      if (levelResult.userPubkeyHex) {
        try {
          const response = await fetch('/api/transfers/pending', {
            headers: {
              'X-User-Pubkey': levelResult.userPubkeyHex
            }
          });
          if (response.ok) {
            const data = await response.json();
            if (data.pendingTransfers && data.pendingTransfers.length > 0) {
              // Trigger a custom event to notify layout about pending transfers
              // The layout component will handle displaying the notifications
              window.dispatchEvent(new CustomEvent('pendingTransfers', { 
                detail: { transfers: data.pendingTransfers } 
              }));
            }
          }
        } catch (err) {
          console.error('Failed to check for pending transfers:', err);
          // Don't fail login if transfer check fails
        }
      }
      
      // Show success message
      const { hasUnlimitedAccess } = await import('../../lib/utils/user-access.js');
      if (hasUnlimitedAccess(levelResult.level)) {
        console.log('Unlimited access granted!');
      } else if (levelResult.level === 'rate_limited') {
        console.log('Logged in with rate-limited access.');
      }
    } catch (err) {
      console.error('Login error:', err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      alert(`Failed to login: ${errorMessage}. Please make sure your Nostr extension is unlocked and try again.`);
    }
  }

  async function logout() {
    userPubkey = null;
    // Reset user store
    userStore.reset();
    // Clear activity tracking
    clearActivity();
    // Navigate to home page to reset all component state to anonymous
    // Use replace to prevent back button from going back to logged-in state
    await goto('/', { replaceState: true, invalidateAll: true });
  }

  function isActive(path: string): boolean {
    return $page.url.pathname === path || $page.url.pathname.startsWith(path + '/');
  }
</script>

<header class="site-header">
  <div class="header-container">
    <a href="/" class="header-logo">
      <img src="/GR_logo.png" alt="GitRepublic Logo" class="main-logo" />
      <h1>gitrepublic</h1>
    </a>
    <nav class:mobile-open={mobileMenuOpen}>
      <div class="nav-links">
        <a href="/repos" class:active={isActive('/repos')} onclick={closeMobileMenu}>Repositories</a>
        <a href="/search" class:active={isActive('/search')} onclick={closeMobileMenu}>Search</a>
        <a href="/signup" class:active={isActive('/signup')} onclick={closeMobileMenu}>Register</a>
        <a href="/docs" class:active={isActive('/docs')} onclick={closeMobileMenu}>Docs</a>
        <a href="/api-docs" class:active={isActive('/api-docs')} onclick={closeMobileMenu}>API Docs</a>
      </div>
    </nav>
    <div class="auth-section">
      <SettingsButton />
      {#if userPubkey}
        {@const userNpub = (() => {
          try {
            // Check if it's already an npub
            if (userPubkey.startsWith('npub')) {
              return userPubkey;
            }
            // Try to decode first (might already be npub)
            try {
              const decoded = nip19.decode(userPubkey);
              if (decoded.type === 'npub') {
                return userPubkey;
              }
            } catch {
              // Not an npub, continue to encode
            }
            // Convert hex pubkey to npub
            return nip19.npubEncode(userPubkey);
          } catch {
            // If all fails, return as-is (will be handled by route)
            return userPubkey;
          }
        })()}
        <a href={`/users/${userNpub}`} class="user-badge-link">
          <UserBadge pubkey={userPubkey} />
        </a>
        <button onclick={logout} class="logout-button">Logout</button>
      {:else}
        <button onclick={login} class="login-button" disabled={!isNIP07Available()}>
          {isNIP07Available() ? 'Login' : 'NIP-07 Not Available'}
        </button>
      {/if}
      <button class="mobile-menu-toggle" onclick={toggleMobileMenu} aria-label="Toggle menu">
        <img src="/icons/menu.svg" alt="Menu" class="hamburger-icon" />
      </button>
    </div>
  </div>
</header>

<style>
  .site-header {
    border-bottom: 1px solid var(--border-color);
    margin-bottom: 2rem;
    background: var(--bg-primary);
    position: relative;
    z-index: 100;
  }

  .header-container {
    max-width: 1200px;
    margin: 0 auto;
    padding: 1rem 2rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 2rem;
    box-sizing: border-box;
    width: 100%;
  }

  .header-logo {
    display: flex;
    align-items: center;
    gap: 1rem;
    text-decoration: none;
    color: inherit;
    transition: opacity 0.2s ease;
    flex-shrink: 0;
  }

  .header-logo:hover {
    opacity: 0.8;
  }

  .main-logo {
    height: 48px;
    width: 48px;
    object-fit: cover;
    border-radius: 50%;
  }

  .header-logo h1 {
    margin: 0;
    font-size: 1.75rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  nav {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .nav-links {
    display: flex;
    gap: 1rem;
    align-items: center;
  }

  .nav-links a {
    text-decoration: none;
    color: var(--link-color);
    transition: color 0.2s ease;
    padding: 0.5rem 0.75rem;
    border-radius: 0.375rem;
    position: relative;
    white-space: nowrap;
  }

  .nav-links a:hover {
    color: var(--link-hover);
  }

  .nav-links a.active {
    color: var(--accent);
    font-weight: 600;
    background: var(--bg-secondary);
  }

  .nav-links a.active::after {
    content: '';
    position: absolute;
    bottom: -1rem;
    left: 50%;
    transform: translateX(-50%);
    width: 80%;
    height: 2px;
    background: var(--accent);
  }

  .auth-section {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
  }

  .user-badge-link {
    text-decoration: none;
    color: inherit;
    display: flex;
    align-items: center;
  }

  .user-badge-link:hover {
    text-decoration: none;
  }

  .mobile-menu-toggle {
    display: none;
    background: transparent;
    border: 1px solid var(--border-color);
    border-radius: 0.375rem;
    padding: 0.5rem;
    cursor: pointer;
    color: var(--text-primary);
    font-size: 1.5rem;
    line-height: 1;
    transition: all 0.2s ease;
  }

  .mobile-menu-toggle:hover {
    background: var(--bg-secondary);
    border-color: var(--accent);
  }

  .hamburger-icon {
    width: 20px;
    height: 20px;
    display: block;
    filter: brightness(0) saturate(100%) invert(1) !important; /* Default white for dark themes */
    opacity: 1 !important;
  }

  /* Light theme: black icon */
  :global([data-theme="light"]) .hamburger-icon {
    filter: brightness(0) saturate(100%) !important; /* Black in light theme */
    opacity: 1 !important;
  }

  /* Dark themes: white icon */
  :global([data-theme="dark"]) .hamburger-icon,
  :global([data-theme="black"]) .hamburger-icon {
    filter: brightness(0) saturate(100%) invert(1) !important; /* White in dark themes */
    opacity: 1 !important;
  }

  /* Hover: white for visibility */
  .mobile-menu-toggle:hover .hamburger-icon {
    filter: brightness(0) saturate(100%) invert(1) !important;
    opacity: 1 !important;
  }

  /* Light theme hover: keep black */
  :global([data-theme="light"]) .mobile-menu-toggle:hover .hamburger-icon {
    filter: brightness(0) saturate(100%) !important;
    opacity: 1 !important;
  }

  /* Mobile responsive styles */
  @media (max-width: 768px) {
    .header-container {
      display: flex;
      flex-wrap: wrap;
      padding: 1rem;
      gap: 1rem;
      justify-content: space-between;
      align-items: center;
    }

    .header-logo {
      flex-shrink: 0;
      order: 1;
    }

    .header-logo h1 {
      font-size: 1.5rem;
    }

    .main-logo {
      height: 40px;
      width: 40px;
    }

    .mobile-menu-toggle {
      display: block;
    }

    nav {
      order: 3;
      flex: none !important;
      width: 100% !important;
      max-height: 0;
      overflow: hidden;
      transition: max-height 0.3s ease;
      flex-direction: column;
      align-items: stretch;
      margin-top: 0;
    }

    nav.mobile-open {
      max-height: 500px;
      padding-top: 1rem;
    }

    .nav-links {
      flex-direction: column;
      width: 100%;
      gap: 0.5rem;
    }

    .nav-links a {
      font-size: 0.875rem;
      padding: 0.75rem 1rem;
      width: 100%;
      text-align: left;
      border-radius: 0.375rem;
      background: var(--bg-secondary);
    }

    .nav-links a:hover {
      background: var(--bg-tertiary);
    }

    .nav-links a.active {
      background: var(--accent);
      color: var(--accent-text, #ffffff);
    }

    .nav-links a.active::after {
      display: none;
    }

    .auth-section {
      order: 2;
      display: flex !important;
      align-items: center;
      gap: 0.5rem;
      flex-shrink: 0;
      margin-left: auto !important;
      justify-content: flex-end;
    }

    .auth-section button {
      font-size: 0.875rem;
      padding: 0.4rem 0.8rem;
    }
  }

  @media (max-width: 480px) {
    .header-container {
      padding: 0.75rem;
    }

    .header-logo {
      gap: 0.5rem;
    }

    .header-logo h1 {
      font-size: 1.25rem;
    }

    .main-logo {
      height: 32px;
      width: 32px;
    }

    .auth-section {
      gap: 0.25rem;
    }

    .auth-section button {
      font-size: 0.75rem;
      padding: 0.35rem 0.6rem;
    }
  }
</style>
