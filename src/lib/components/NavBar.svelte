<script lang="ts">
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { getPublicKeyWithNIP07, isNIP07Available } from '../services/nostr/nip07-signer.js';
  import { nip19 } from 'nostr-tools';
  import ThemeToggle from './ThemeToggle.svelte';
  import UserBadge from './UserBadge.svelte';
  import { onMount } from 'svelte';
  import { userStore } from '../stores/user-store.js';
  import { clearActivity, updateActivity } from '../services/activity-tracker.js';

  let userPubkey = $state<string | null>(null);
  let mobileMenuOpen = $state(false);

  onMount(async () => {
    await checkAuth();
    // Update activity on mount
    updateActivity();
    
    // Set up activity tracking for user interactions
    const updateActivityOnInteraction = () => updateActivity();
    
    // Track various user interactions
    document.addEventListener('click', updateActivityOnInteraction, { passive: true });
    document.addEventListener('keydown', updateActivityOnInteraction, { passive: true });
    document.addEventListener('scroll', updateActivityOnInteraction, { passive: true });
    
    return () => {
      document.removeEventListener('click', updateActivityOnInteraction);
      document.removeEventListener('keydown', updateActivityOnInteraction);
      document.removeEventListener('scroll', updateActivityOnInteraction);
    };
  });

  function toggleMobileMenu() {
    mobileMenuOpen = !mobileMenuOpen;
  }

  function closeMobileMenu() {
    mobileMenuOpen = false;
  }

  async function checkAuth() {
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
    try {
      if (!isNIP07Available()) {
        alert('NIP-07 extension not found. Please install a Nostr extension like Alby or nos2x.');
        return;
      }
      userPubkey = await getPublicKeyWithNIP07();
    } catch (err) {
      console.error('Login error:', err);
    }
  }

  function logout() {
    userPubkey = null;
    // Reset user store
    userStore.reset();
    // Clear activity tracking
    clearActivity();
    // Navigate to home page to reset all component state to anonymous
    goto('/');
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
        <a href="/" class:active={isActive('/') && $page.url.pathname === '/'} onclick={closeMobileMenu}>Repositories</a>
        <a href="/search" class:active={isActive('/search')} onclick={closeMobileMenu}>Search</a>
        <a href="/signup" class:active={isActive('/signup')} onclick={closeMobileMenu}>Sign Up</a>
        <a href="/docs" class:active={isActive('/docs')} onclick={closeMobileMenu}>Docs</a>
      </div>
    </nav>
    <div class="auth-section">
      <ThemeToggle />
      {#if userPubkey}
        <UserBadge pubkey={userPubkey} />
        <button onclick={logout} class="logout-button">Logout</button>
      {:else}
        <button onclick={login} class="login-button" disabled={!isNIP07Available()}>
          {isNIP07Available() ? 'Login' : 'NIP-07 Not Available'}
        </button>
      {/if}
      <button class="mobile-menu-toggle" onclick={toggleMobileMenu} aria-label="Toggle menu">
        <span class="hamburger-icon">☰</span>
      </button>
    </div>
  </div>
</header>

<style>
  .site-header {
    border-bottom: 1px solid var(--border-color);
    margin-bottom: 2rem;
    background: var(--bg-primary);
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
    display: block;
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
      color: white;
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
