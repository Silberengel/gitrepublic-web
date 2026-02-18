<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { getPublicKeyWithNIP07, isNIP07Available } from '../lib/services/nostr/nip07-signer.js';
  import { nip19 } from 'nostr-tools';
  import { determineUserLevel, decodePubkey } from '../lib/services/nostr/user-level-service.js';
  import { userStore } from '../lib/stores/user-store.js';
  import { updateActivity } from '../lib/services/activity-tracker.js';

  let userPubkey = $state<string | null>(null);
  let userPubkeyHex = $state<string | null>(null);
  let checkingAuth = $state(true);
  let checkingLevel = $state(false);
  let levelMessage = $state<string | null>(null);

  onMount(() => {
    // Prevent body scroll when splash page is shown
    document.body.style.overflow = 'hidden';
    
    // Check auth asynchronously
    checkAuth();
    
    // Return cleanup function
    return () => {
      // Re-enable scrolling when component is destroyed
      document.body.style.overflow = '';
    };
  });

  async function checkAuth() {
    checkingAuth = true;
    if (isNIP07Available()) {
      try {
        userPubkey = await getPublicKeyWithNIP07();
        // Convert npub to hex for API calls
        // NIP-07 may return either npub or hex
        if (/^[0-9a-f]{64}$/i.test(userPubkey)) {
          // Already hex format
          userPubkeyHex = userPubkey.toLowerCase();
        } else {
          // Try to decode as npub
          try {
            const decoded = nip19.decode(userPubkey);
            if (decoded.type === 'npub') {
              userPubkeyHex = decoded.data as string;
            } else {
              userPubkeyHex = userPubkey; // Unknown type, use as-is
            }
          } catch {
            userPubkeyHex = userPubkey; // Assume it's already hex or use as-is
          }
        }
      } catch (err) {
        console.warn('Failed to load user pubkey:', err);
      }
    }
    checkingAuth = false;
  }

  async function handleLogin() {
    if (isNIP07Available()) {
      try {
        checkingLevel = true;
        levelMessage = 'Checking authentication...';
        
        await checkAuth();
        
        if (userPubkey && userPubkeyHex) {
          levelMessage = 'Verifying relay write access...';
          
          // Determine user level (checks relay write access)
          const levelResult = await determineUserLevel(userPubkey, userPubkeyHex);
          
          // Update user store
          userStore.setUser(
            levelResult.userPubkey,
            levelResult.userPubkeyHex,
            levelResult.level,
            levelResult.error || null
          );
          
          // Update activity tracking on successful login
          updateActivity();
          
          checkingLevel = false;
          levelMessage = null;
          
          // Show appropriate message based on level
          if (levelResult.level === 'unlimited') {
            levelMessage = 'Unlimited access granted!';
          } else if (levelResult.level === 'rate_limited') {
            levelMessage = 'Logged in with rate-limited access.';
          }
          
          // User is logged in, go to repos page
          goto('/repos');
        } else {
          checkingLevel = false;
          levelMessage = null;
        }
      } catch (err) {
        console.error('Login failed:', err);
        checkingLevel = false;
        levelMessage = null;
        alert('Failed to login. Please make sure you have a Nostr extension installed (like nos2x or Alby).');
      }
    } else {
      alert('Nostr extension not found. Please install a Nostr extension like nos2x or Alby to login.');
    }
  }

  function handleViewPublic() {
    goto('/repos');
  }

  // Get page data for OpenGraph metadata
  const pageData = $page.data as {
    title?: string;
    description?: string;
    image?: string;
    url?: string;
    ogType?: string;
  };
</script>

<svelte:head>
  <title>{pageData.title || 'GitRepublic - Decentralized Git Hosting on Nostr'}</title>
  <meta name="description" content={pageData.description || 'A decentralized git hosting platform built on Nostr. Host your repositories, collaborate with others, and maintain full control of your code.'} />
  
  <!-- OpenGraph / Facebook -->
  <meta property="og:type" content={pageData.ogType || 'website'} />
  <meta property="og:title" content={pageData.title || 'GitRepublic - Decentralized Git Hosting on Nostr'} />
  <meta property="og:description" content={pageData.description || 'A decentralized git hosting platform built on Nostr. Host your repositories, collaborate with others, and maintain full control of your code.'} />
  <meta property="og:url" content={pageData.url || `https://${$page.url.host}${$page.url.pathname}`} />
  {#if pageData.image}
    <meta property="og:image" content={pageData.image} />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
  {/if}
  
  <!-- Twitter Card -->
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content={pageData.title || 'GitRepublic - Decentralized Git Hosting on Nostr'} />
  <meta name="twitter:description" content={pageData.description || 'A decentralized git hosting platform built on Nostr. Host your repositories, collaborate with others, and maintain full control of your code.'} />
  {#if pageData.image}
    <meta name="twitter:image" content={pageData.image} />
  {/if}
</svelte:head>

<div class="splash-container">
  <div class="splash-background">
    <img src="/logo.png" alt="GitRepublic Logo" class="splash-logo-bg" />
  </div>
  
  <div class="splash-content">
    <div class="splash-header">
      <h1 class="splash-title">GitRepublic</h1>
      <p class="splash-subtitle">Decentralized Git Hosting on Nostr</p>
    </div>

    <div class="splash-message">
      {#if checkingAuth || checkingLevel}
        <p class="splash-text">{levelMessage || 'Checking authentication...'}</p>
        {#if checkingLevel && levelMessage}
          <p class="splash-text-secondary">This may take a few seconds...</p>
        {/if}
      {:else if userPubkey}
        <p class="splash-text">Welcome back! You're logged in.</p>
        <p class="splash-text-secondary">You can now access all repositories you have permission to view.</p>
      {:else}
        <p class="splash-text">Login for full functionality</p>
        <p class="splash-text-secondary">Access your private repositories, create new ones, and collaborate with others.</p>
        <p class="splash-text-secondary">Or browse public repositories without logging in.</p>
      {/if}
    </div>

    <div class="splash-actions">
      {#if checkingAuth || checkingLevel}
        <div class="splash-loading">Loading...</div>
      {:else if userPubkey}
        <button class="splash-button splash-button-primary" onclick={() => goto('/repos')}>
          View Repositories
        </button>
      {:else}
        <button class="splash-button splash-button-primary" onclick={handleLogin}>
          Login with Nostr
        </button>
        <button class="splash-button splash-button-secondary" onclick={handleViewPublic}>
          View Public Repositories
        </button>
      {/if}
    </div>

  </div>
</div>

<style>
  .splash-container {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    width: 100vw;
    height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9999;
    overflow: hidden;
    background: linear-gradient(135deg, var(--bg-primary, #f5f5f5) 0%, var(--bg-secondary, #e8e8e8) 100%);
    /* Ensure it covers everything and blocks interaction */
    pointer-events: auto;
  }

  .splash-background {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    opacity: 0.05;
    z-index: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .splash-logo-bg {
    width: 80vw;
    height: 80vh;
    object-fit: contain;
    filter: blur(20px);
  }

  .splash-content {
    position: relative;
    z-index: 1;
    text-align: center;
    padding: 3rem 2rem;
    max-width: 800px;
    width: 100%;
  }

  .splash-header {
    margin-bottom: 3rem;
  }

  .splash-title {
    font-size: 3.5rem;
    font-weight: 700;
    margin: 0 0 0.5rem;
    color: var(--text-primary, #1a1a1a);
    text-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
  }

  .splash-subtitle {
    font-size: 1.5rem;
    color: var(--text-secondary, #666);
    margin: 0;
    font-weight: 300;
  }

  .splash-message {
    margin-bottom: 3rem;
  }

  .splash-text {
    font-size: 1.5rem;
    color: var(--text-primary, #1a1a1a);
    margin: 0 0 1rem;
    font-weight: 500;
  }

  .splash-text-secondary {
    font-size: 1.1rem;
    color: var(--text-secondary, #666);
    margin: 0.5rem 0;
    line-height: 1.6;
  }

  .splash-actions {
    display: flex;
    gap: 1rem;
    justify-content: center;
    flex-wrap: wrap;
    margin-bottom: 4rem;
  }

  .splash-button {
    padding: 1rem 2.5rem;
    font-size: 1.1rem;
    font-weight: 600;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.3s ease;
    text-decoration: none;
    display: inline-block;
    min-width: 200px;
  }

  .splash-button-primary {
    background: var(--accent, #007bff);
    color: white;
    box-shadow: 0 4px 6px rgba(0, 123, 255, 0.3);
  }

  .splash-button-primary:hover {
    background: var(--accent-hover, #0056b3);
    transform: translateY(-2px);
    box-shadow: 0 6px 12px rgba(0, 123, 255, 0.4);
  }

  .splash-button-secondary {
    background: white;
    color: var(--accent, #007bff);
    border: 2px solid var(--accent, #007bff);
  }

  .splash-button-secondary:hover {
    background: var(--accent, #007bff);
    color: white;
    transform: translateY(-2px);
  }

  .splash-loading {
    font-size: 1.2rem;
    color: var(--text-secondary, #666);
    padding: 2rem;
  }

  @media (max-width: 768px) {
    .splash-title {
      font-size: 2.5rem;
    }

    .splash-subtitle {
      font-size: 1.2rem;
    }

    .splash-text {
      font-size: 1.2rem;
    }

    .splash-button {
      width: 100%;
      min-width: unset;
    }
  }

  @media (prefers-color-scheme: dark) {
    .splash-container {
      background: linear-gradient(135deg, var(--bg-primary, #1a1a1a) 0%, var(--bg-secondary, #2d2d2d) 100%);
    }

    .splash-title {
      color: var(--text-primary, #f5f5f5);
    }

    .splash-text {
      color: var(--text-primary, #f5f5f5);
    }

    .splash-button-secondary {
      background: var(--bg-secondary, #2d2d2d);
      border-color: var(--accent, #007bff);
    }
  }
</style>
