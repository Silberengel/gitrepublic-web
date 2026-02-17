<script lang="ts">
  import { page } from '$app/stores';
  import { getPublicKeyWithNIP07, isNIP07Available } from '../services/nostr/nip07-signer.js';
  import { nip19 } from 'nostr-tools';
  import ThemeToggle from './ThemeToggle.svelte';
  import UserBadge from './UserBadge.svelte';
  import { onMount } from 'svelte';

  let userPubkey = $state<string | null>(null);

  onMount(async () => {
    await checkAuth();
  });

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
    <nav>
      <div class="nav-links">
        <a href="/" class:active={isActive('/') && $page.url.pathname === '/'}>Repositories</a>
        <a href="/search" class:active={isActive('/search')}>Search</a>
        <a href="/signup" class:active={isActive('/signup')}>Sign Up</a>
        <a href="/docs" class:active={isActive('/docs')}>Docs</a>
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

  /* Mobile responsive styles */
  @media (max-width: 768px) {
    .header-container {
      flex-direction: column;
      padding: 1rem;
      gap: 1rem;
    }

    .header-logo h1 {
      font-size: 1.5rem;
    }

    .main-logo {
      height: 40px;
      width: 40px;
    }

    nav {
      width: 100%;
    }

    .nav-links {
      flex-wrap: wrap;
      justify-content: center;
      gap: 0.5rem;
      width: 100%;
    }

    .nav-links a {
      font-size: 0.875rem;
      padding: 0.4rem 0.6rem;
    }

    .nav-links a.active::after {
      display: none;
    }

    .auth-section {
      width: 100%;
      justify-content: center;
      flex-wrap: wrap;
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

    .nav-links {
      flex-direction: column;
      width: 100%;
    }

    .nav-links a {
      width: 100%;
      text-align: center;
    }
  }
</style>
