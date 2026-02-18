<script lang="ts">
  import { onMount } from 'svelte';
  import { getPublicKeyWithNIP07, isNIP07Available } from '$lib/services/nostr/nip07-signer.js';
  import { nip19 } from 'nostr-tools';

  interface ForwardingSummary {
    configured: boolean;
    enabled: boolean;
    platforms: {
      telegram?: boolean;
      simplex?: boolean;
      email?: boolean;
      gitPlatforms?: Array<{
        platform: string;
        owner: string;
        repo: string;
        apiUrl?: string;
      }>;
    };
    notifyOn?: string[];
  }

  interface Props {
    userPubkeyHex?: string | null;
    showTitle?: boolean;
    compact?: boolean;
  }

  let { userPubkeyHex = null, showTitle = true, compact = false }: Props = $props();

  let loading = $state(true);
  let summary = $state<ForwardingSummary | null>(null);
  let error = $state<string | null>(null);
  let currentUserPubkey = $state<string | null>(null);

  const KIND_NAMES: Record<string, string> = {
    '1621': 'Issues',
    '1618': 'Pull Requests',
    '9802': 'Highlights',
    '30617': 'Repository Announcements',
    '1641': 'Ownership Transfers'
  };

  onMount(async () => {
    await loadCurrentUser();
    if (userPubkeyHex || currentUserPubkey) {
      await loadForwardingSummary();
    } else {
      loading = false;
    }
  });

  async function loadCurrentUser() {
    if (userPubkeyHex) {
      currentUserPubkey = userPubkeyHex;
      return;
    }

    if (!isNIP07Available()) {
      return;
    }

    try {
      const pubkey = await getPublicKeyWithNIP07();
      try {
        const decoded = nip19.decode(pubkey);
        if (decoded.type === 'npub') {
          currentUserPubkey = decoded.data as string;
        } else {
          currentUserPubkey = pubkey;
        }
      } catch {
        currentUserPubkey = pubkey;
      }
    } catch (err) {
      console.warn('Failed to load current user:', err);
    }
  }

  async function loadForwardingSummary() {
    const pubkey = userPubkeyHex || currentUserPubkey;
    if (!pubkey) {
      loading = false;
      return;
    }

    loading = true;
    error = null;

    try {
      const response = await fetch('/api/user/messaging-preferences/summary', {
        headers: {
          'X-User-Pubkey': pubkey
        }
      });

      if (response.status === 401 || response.status === 403) {
        // User not authenticated or doesn't have access
        loading = false;
        return;
      }

      if (!response.ok) {
        throw new Error(`Failed to load forwarding summary: ${response.statusText}`);
      }

      summary = await response.json();
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load forwarding configuration';
      console.error('Error loading forwarding summary:', err);
    } finally {
      loading = false;
    }
  }

  function getPlatformIcon(platform: string): string {
    const icons: Record<string, string> = {
      github: '🐙',
      gitlab: '🦊',
      gitea: '🐈',
      codeberg: '🦫',
      forgejo: '🔨',
      onedev: '📦',
      custom: '⚙️'
    };
    return icons[platform.toLowerCase()] || '📦';
  }

  function getPlatformName(platform: string): string {
    const names: Record<string, string> = {
      github: 'GitHub',
      gitlab: 'GitLab',
      gitea: 'Gitea',
      codeberg: 'Codeberg',
      forgejo: 'Forgejo',
      onedev: 'OneDev',
      custom: 'Custom'
    };
    return names[platform.toLowerCase()] || platform;
  }
</script>

{#if loading}
  <div class="forwarding-config loading">
    {#if showTitle}
      <h3>Event Forwarding</h3>
    {/if}
    <p class="loading-text">Loading...</p>
  </div>
{:else if error}
  <div class="forwarding-config error">
    {#if showTitle}
      <h3>Event Forwarding</h3>
    {/if}
    <p class="error-text">{error}</p>
  </div>
{:else if !summary || !summary.configured}
  <div class="forwarding-config not-configured">
    {#if showTitle}
      <h3>Event Forwarding</h3>
    {/if}
    <p class="not-configured-text">
      {compact ? 'Not configured' : 'No forwarding configured. Events will not be forwarded to external platforms.'}
    </p>
  </div>
{:else if !summary.enabled}
  <div class="forwarding-config disabled">
    {#if showTitle}
      <h3>Event Forwarding</h3>
    {/if}
    <p class="disabled-text">Forwarding is disabled</p>
  </div>
{:else}
  <div class="forwarding-config configured" class:compact={compact}>
    {#if showTitle}
      <h3>Event Forwarding</h3>
    {/if}
    
    <div class="platforms">
      {#if summary.platforms.telegram}
        <div class="platform-item">
          <span class="platform-icon">📱</span>
          <span class="platform-name">Telegram</span>
        </div>
      {/if}

      {#if summary.platforms.simplex}
        <div class="platform-item">
          <span class="platform-icon">💬</span>
          <span class="platform-name">SimpleX</span>
        </div>
      {/if}

      {#if summary.platforms.email}
        <div class="platform-item">
          <span class="platform-icon">📧</span>
          <span class="platform-name">Email</span>
        </div>
      {/if}

      {#if summary.platforms.gitPlatforms && summary.platforms.gitPlatforms.length > 0}
        {#each summary.platforms.gitPlatforms as gitPlatform}
          <div class="platform-item">
            <span class="platform-icon">{getPlatformIcon(gitPlatform.platform)}</span>
            <span class="platform-name">
              {getPlatformName(gitPlatform.platform)}
              {#if !compact}
                <span class="platform-details">
                  ({gitPlatform.owner}/{gitPlatform.repo}
                  {#if gitPlatform.apiUrl}
                    <span class="custom-url" title={gitPlatform.apiUrl}>*</span>
                  {/if})
                </span>
              {/if}
            </span>
          </div>
        {/each}
      {/if}
    </div>

    {#if summary.notifyOn && summary.notifyOn.length > 0 && !compact}
      <div class="notify-on">
        <strong>Forwarding events:</strong>
        <span class="event-kinds">
          {#each summary.notifyOn as kind}
            <span class="event-kind">{KIND_NAMES[kind] || `Kind ${kind}`}</span>
          {/each}
        </span>
      </div>
    {/if}
  </div>
{/if}

<style>
  .forwarding-config {
    padding: 1rem;
    border-radius: 8px;
    background: var(--bg-secondary, #f5f5f5);
    border: 1px solid var(--border-color, #ddd);
    margin: 1rem 0;
  }

  .forwarding-config h3 {
    margin: 0 0 0.75rem 0;
    font-size: 1.1rem;
    color: var(--text-primary, #333);
  }

  .forwarding-config.loading .loading-text,
  .forwarding-config.not-configured .not-configured-text,
  .forwarding-config.disabled .disabled-text,
  .forwarding-config.error .error-text {
    color: var(--text-secondary, #666);
    font-size: 0.9rem;
    margin: 0;
  }

  .forwarding-config.error .error-text {
    color: var(--error-color, #d32f2f);
  }

  .forwarding-config.disabled .disabled-text {
    color: var(--warning-color, #f57c00);
  }

  .platforms {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    margin: 0.5rem 0;
  }

  .platform-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    background: var(--bg-primary, #fff);
    border: 1px solid var(--border-color, #ddd);
    border-radius: 6px;
    font-size: 0.9rem;
  }

  .platform-icon {
    font-size: 1.2rem;
  }

  .platform-name {
    color: var(--text-primary, #333);
    font-weight: 500;
  }

  .platform-details {
    color: var(--text-secondary, #666);
    font-weight: normal;
    font-size: 0.85rem;
    margin-left: 0.25rem;
  }

  .custom-url {
    color: var(--accent, #1976d2);
    font-weight: bold;
    cursor: help;
  }

  .notify-on {
    margin-top: 0.75rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--border-color, #ddd);
    font-size: 0.9rem;
    color: var(--text-secondary, #666);
  }

  .notify-on strong {
    color: var(--text-primary, #333);
    margin-right: 0.5rem;
  }

  .event-kinds {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .event-kind {
    padding: 0.25rem 0.5rem;
    background: var(--bg-primary, #fff);
    border: 1px solid var(--border-color, #ddd);
    border-radius: 4px;
    font-size: 0.85rem;
    color: var(--text-primary, #333);
  }

  /* Compact mode */
  .forwarding-config.compact {
    padding: 0.5rem;
  }

  .forwarding-config.compact h3 {
    font-size: 1rem;
    margin-bottom: 0.5rem;
  }

  .forwarding-config.compact .platform-item {
    padding: 0.25rem 0.5rem;
    font-size: 0.85rem;
  }
</style>
