<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { NostrClient } from '$lib/services/nostr/nostr-client.js';
  import { DEFAULT_NOSTR_RELAYS } from '$lib/config.js';
  import { nip19 } from 'nostr-tools';
  import type { NostrEvent } from '$lib/types/nostr.js';
  import { getPublicKeyWithNIP07, isNIP07Available, signEventWithNIP07 } from '$lib/services/nostr/nip07-signer.js';
  import { PublicMessagesService, type PublicMessage } from '$lib/services/nostr/public-messages-service.js';
  import { getUserRelays } from '$lib/services/nostr/user-relays.js';
  import UserBadge from '$lib/components/UserBadge.svelte';
  import { userStore } from '$lib/stores/user-store.js';
  import { fetchUserProfile, extractProfileData } from '$lib/utils/user-profile.js';
  import { combineRelays } from '$lib/config.js';

  const npub = ($page.params as { npub?: string }).npub || '';

  // State
  let loading = $state(true);
  let error = $state<string | null>(null);
  let profileOwnerPubkeyHex = $state<string | null>(null);
  let viewerPubkeyHex = $state<string | null>(null);
  let repos = $state<NostrEvent[]>([]);
  let userProfile = $state<{ name?: string; about?: string; picture?: string } | null>(null);
  let profileEvent = $state<NostrEvent | null>(null);
  let profileData = $state<any>(null);
  let profileTags = $state<Array<{ name: string; value: string }>>([]);
  let paymentTargets = $state<Array<{ type: string; authority: string; payto: string }>>([]);
  
  // Messages
  let activeTab = $state<'repos' | 'messages'>('repos');
  let messages = $state<PublicMessage[]>([]);
  let loadingMessages = $state(false);
  let showSendMessageDialog = $state(false);
  let newMessageContent = $state('');
  let sendingMessage = $state(false);
  let messagesService: PublicMessagesService | null = null;

  const nostrClient = new NostrClient(DEFAULT_NOSTR_RELAYS);
  const gitDomain = $page.data.gitDomain || 'localhost:6543';

  // Sync viewer pubkey from store
  $effect(() => {
    const currentUser = $userStore;
    viewerPubkeyHex = currentUser.userPubkeyHex || null;
  });

  onMount(async () => {
    await loadUserProfile();
  });

  // Load messages when tab is active
  $effect(() => {
    if (activeTab === 'messages' && profileOwnerPubkeyHex && messages.length === 0 && !loadingMessages) {
      loadMessages();
    }
  });

  async function loadUserProfile() {
    loading = true;
    error = null;

    try {
      // Decode npub
      const decoded = nip19.decode(npub);
      if (decoded.type !== 'npub') {
        error = 'Invalid npub format';
        return;
      }
      profileOwnerPubkeyHex = decoded.data as string;

      // Load repositories
      const url = `/api/users/${npub}/repos?domain=${encodeURIComponent(gitDomain)}`;
      const response = await fetch(url, {
        headers: viewerPubkeyHex ? { 'X-User-Pubkey': viewerPubkeyHex } : {}
      });

      if (!response.ok) {
        throw new Error(`Failed to load repositories: ${response.statusText}`);
      }

      const data = await response.json();
      repos = data.repos || [];

      // Load profile
      profileEvent = await fetchUserProfile(profileOwnerPubkeyHex, DEFAULT_NOSTR_RELAYS);
      
      if (profileEvent) {
        // Parse JSON content
        try {
          if (profileEvent.content?.trim()) {
            profileData = JSON.parse(profileEvent.content);
          }
        } catch {
          profileData = null;
        }
        
        // Extract tags
        profileTags = profileEvent.tags
          .filter(t => t.length > 0 && t[0])
          .map(t => ({ name: t[0], value: t.slice(1).join(', ') }));

        // Extract profile fields
        const nameTag = profileEvent.tags.find(t => t[0] === 'name' || t[0] === 'display_name')?.[1];
        const aboutTag = profileEvent.tags.find(t => t[0] === 'about')?.[1];
        const pictureTag = profileEvent.tags.find(t => t[0] === 'picture' || t[0] === 'avatar')?.[1];

        userProfile = {
          name: nameTag || profileData?.display_name || profileData?.name,
          about: aboutTag || profileData?.about,
          picture: pictureTag || profileData?.picture
        };
      }

      // Load payment targets (kind 10133)
      const paymentEvents = await nostrClient.fetchEvents([{
        kinds: [10133],
        authors: [profileOwnerPubkeyHex],
        limit: 1
      }]);

      const lightningAddresses = new Set<string>();
      
      // Extract from profile event
      if (profileEvent) {
        const lud16Tags = profileEvent.tags.filter(t => t[0] === 'lud16').map(t => t[1]).filter(Boolean);
        lud16Tags.forEach(addr => lightningAddresses.add(addr.toLowerCase()));
        if (profileData?.lud16) {
          lightningAddresses.add(profileData.lud16.toLowerCase());
        }
      }

      // Extract from kind 10133
      if (paymentEvents.length > 0) {
        const paytoTags = paymentEvents[0].tags.filter(t => t[0] === 'payto' && t[1] === 'lightning' && t[2]);
        paytoTags.forEach(tag => {
          if (tag[2]) lightningAddresses.add(tag[2].toLowerCase());
        });
      }

      // Build payment targets
      const targets: Array<{ type: string; authority: string; payto: string }> = 
        Array.from(lightningAddresses).map(authority => ({
          type: 'lightning',
          authority,
          payto: `payto://lightning/${authority}`
        }));

      if (paymentEvents.length > 0) {
        const otherPaytoTags = paymentEvents[0].tags.filter(t => 
          t[0] === 'payto' && t[1] && t[1] !== 'lightning' && t[2]
        );
        otherPaytoTags.forEach(tag => {
          const type = tag[1]?.toLowerCase() || '';
          const authority = tag[2] || '';
          if (type && authority && !targets.find(p => p.type === type && p.authority.toLowerCase() === authority.toLowerCase())) {
            targets.push({ type, authority, payto: `payto://${type}/${authority}` });
          }
        });
      }

      paymentTargets = targets;
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load user profile';
      console.error('Error loading user profile:', err);
    } finally {
      loading = false;
    }
  }

  async function loadMessages() {
    if (!profileOwnerPubkeyHex || loadingMessages) return;
    
    loadingMessages = true;
    try {
      if (!messagesService) {
        messagesService = new PublicMessagesService(DEFAULT_NOSTR_RELAYS);
      }
      const allMessages = await messagesService.getAllMessagesForUser(profileOwnerPubkeyHex, 100);
      // Filter out gitrepublic-write-proof kind 24 events
      messages = allMessages.filter(msg => {
        // Skip kind 24 events that contain "gitrepublic-write-proof" in content
        if (msg.kind === 24 && msg.content && msg.content.includes('gitrepublic-write-proof')) {
          return false;
        }
        return true;
      });
    } catch (err) {
      console.error('Error loading messages:', err);
    } finally {
      loadingMessages = false;
    }
  }

  async function sendMessage() {
    if (!newMessageContent.trim() || !viewerPubkeyHex || !profileOwnerPubkeyHex) {
      alert('Please enter a message and make sure you are logged in');
      return;
    }

    if (viewerPubkeyHex === profileOwnerPubkeyHex) {
      alert('You cannot send a message to yourself');
      return;
    }

    sendingMessage = true;
    try {
      if (!messagesService) {
        messagesService = new PublicMessagesService(DEFAULT_NOSTR_RELAYS);
      }
      
      const messageEvent = await messagesService.sendPublicMessage(
        viewerPubkeyHex,
        newMessageContent.trim(),
        [{ pubkey: profileOwnerPubkeyHex }]
      );

      const { outbox } = await getUserRelays(viewerPubkeyHex, nostrClient);
      const combinedRelays = combineRelays(outbox);
      const signedEvent = await signEventWithNIP07(messageEvent);
      const result = await nostrClient.publishEvent(signedEvent, combinedRelays);

      if (result.failed.length > 0 && result.success.length === 0) {
        throw new Error('Failed to publish message to all relays');
      }

      await loadMessages();
      showSendMessageDialog = false;
      newMessageContent = '';
      alert('Message sent successfully!');
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to send message');
    } finally {
      sendingMessage = false;
    }
  }

  function getRepoName(event: NostrEvent): string {
    return event.tags.find(t => t[0] === 'name')?.[1] || 
           event.tags.find(t => t[0] === 'd')?.[1] || 
           'Unnamed';
  }

  function getRepoDescription(event: NostrEvent): string {
    return event.tags.find(t => t[0] === 'description')?.[1] || '';
  }

  function getRepoId(event: NostrEvent): string {
    return event.tags.find(t => t[0] === 'd')?.[1] || '';
  }

  function getMessageRecipients(message: PublicMessage): string[] {
    return message.tags
      .filter(tag => tag[0] === 'p' && tag[1])
      .map(tag => tag[1]);
  }

  function formatMessageTime(timestamp: number): string {
    const date = new Date(timestamp * 1000);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  }

  async function copyPaytoAddress(payto: string) {
    try {
      await navigator.clipboard.writeText(payto);
      alert('Payment address copied to clipboard!');
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }

  async function copyLightningAddress(authority: string) {
    try {
      await navigator.clipboard.writeText(authority);
      alert('Lightning address copied to clipboard!');
    } catch (err) {
      console.error('Failed to copy lightning address:', err);
    }
  }

  const isOwnProfile = $derived(viewerPubkeyHex === profileOwnerPubkeyHex);
</script>

<div class="profile-page">
  {#if loading}
    <div class="loading-state">
      <div class="spinner"></div>
      <p>Loading profile...</p>
    </div>
  {:else if error}
    <div class="error-state">
      <h2>Error</h2>
      <p>{error}</p>
    </div>
  {:else}
    <!-- Profile Header -->
    <header class="profile-header">
      <div class="profile-avatar-section">
        {#if userProfile?.picture}
          <img src={userProfile.picture} alt="Profile" class="profile-avatar" />
        {:else}
          <div class="profile-avatar-placeholder">
            {npub.slice(0, 2).toUpperCase()}
          </div>
        {/if}
      </div>
      
      <div class="profile-info">
        <h1 class="profile-name">{userProfile?.name || npub.slice(0, 16) + '...'}</h1>
        {#if userProfile?.about}
          <p class="profile-bio">{userProfile.about}</p>
        {/if}
        <div class="profile-meta">
          <code class="profile-npub">{npub}</code>
        </div>
      </div>

      {#if isOwnProfile}
        <div class="profile-actions">
          <a href="/dashboard" class="action-button">
            <img src="/icons/layout-dashboard.svg" alt="Dashboard" class="icon-themed" />
            Dashboard
          </a>
        </div>
      {/if}
    </header>

    <!-- Payment Targets -->
    {#if paymentTargets.length > 0}
      <section class="payment-section">
        <h2>Payment Methods</h2>
        <div class="payment-grid">
          {#each paymentTargets as target}
            <div class="payment-card">
              <div class="payment-header">
                <span class="payment-type">{target.type}</span>
              </div>
              <code class="payment-address">{target.payto}</code>
              <div class="payment-actions">
                {#if target.type === 'lightning'}
                  <button 
                    class="lightning-button" 
                    onclick={() => copyLightningAddress(target.authority)}
                    title="Copy lightning address"
                  >
                    <img src="/icons/lightning.svg" alt="Lightning" class="icon-themed" />
                  </button>
                {/if}
                <button 
                  class="copy-button" 
                  onclick={() => copyPaytoAddress(target.payto)}
                  title="Copy payto address"
                >
                  <img src="/icons/copy.svg" alt="Copy" class="icon-themed" />
                </button>
              </div>
            </div>
          {/each}
        </div>
      </section>
    {/if}

    <!-- Tabs -->
    <div class="tabs-container">
      <div class="tabs">
        <button 
          class="tab" 
          class:active={activeTab === 'repos'}
          onclick={() => activeTab = 'repos'}
        >
          Repositories <span class="tab-count">({repos.length})</span>
        </button>
        <button 
          class="tab" 
          class:active={activeTab === 'messages'}
          onclick={() => activeTab = 'messages'}
        >
          Messages <span class="tab-count">({messages.length})</span>
        </button>
      </div>
    </div>

    <!-- Tab Content -->
    <main class="tab-content">
      {#if activeTab === 'repos'}
        <section class="repos-section">
          {#if repos.length === 0}
            <div class="empty-state">
              <p>No repositories found</p>
            </div>
          {:else}
            <div class="repo-grid">
              {#each repos as event}
                {@const repoId = getRepoId(event)}
                <div 
                  class="repo-card" 
                  role="button"
                  tabindex="0"
                  onclick={() => goto(`/repos/${npub}/${repoId}`)}
                  onkeydown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      goto(`/repos/${npub}/${repoId}`);
                    }
                  }}
                >
                  <h3 class="repo-name">{getRepoName(event)}</h3>
                  {#if getRepoDescription(event)}
                    <p class="repo-description">{getRepoDescription(event)}</p>
                  {/if}
                  <div class="repo-footer">
                    <span class="repo-date">
                      {new Date(event.created_at * 1000).toLocaleDateString()}
                    </span>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </section>
      {:else if activeTab === 'messages'}
        <section class="messages-section">
          <div class="messages-header">
            <h2>Public Messages</h2>
            {#if viewerPubkeyHex && !isOwnProfile}
              <button onclick={() => showSendMessageDialog = true} class="send-button">
                Send Message
              </button>
            {/if}
          </div>

          {#if loadingMessages}
            <div class="loading-state">
              <div class="spinner"></div>
              <p>Loading messages...</p>
            </div>
          {:else if messages.length === 0}
            <div class="empty-state">
              <p>No messages found</p>
            </div>
          {:else}
            <div class="messages-list">
              {#each messages as message}
                {@const isFromViewer = viewerPubkeyHex !== null && message.pubkey === viewerPubkeyHex}
                {@const isToViewer = viewerPubkeyHex !== null && getMessageRecipients(message).includes(viewerPubkeyHex)}
                <div class="message-card" class:from-viewer={isFromViewer} class:to-viewer={isToViewer && !isFromViewer}>
                  <div class="message-header">
                    <div class="message-participants">
                      <span class="participants-label">From:</span>
                      <UserBadge pubkey={message.pubkey} />
                      {#if getMessageRecipients(message).length > 0}
                        <span class="participants-label">To:</span>
                        {#each getMessageRecipients(message) as recipientPubkey}
                          <UserBadge pubkey={recipientPubkey} />
                        {/each}
                      {/if}
                    </div>
                    <span class="message-time">{formatMessageTime(message.created_at)}</span>
                  </div>
                  <div class="message-body">{message.content}</div>
                </div>
              {/each}
            </div>
          {/if}
        </section>
      {/if}
    </main>
  {/if}
</div>

<!-- Send Message Dialog -->
{#if showSendMessageDialog}
  <div 
    class="modal-overlay" 
    role="dialog"
    aria-modal="true"
    aria-label="Send message"
    onclick={() => showSendMessageDialog = false}
    onkeydown={(e) => {
      if (e.key === 'Escape') {
        showSendMessageDialog = false;
      }
    }}
    tabindex="-1"
  >
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div class="modal" role="document" onclick={(e) => e.stopPropagation()}>
      <h3>Send Public Message</h3>
      <p class="modal-note">This message will be publicly visible.</p>
      <label>
        <textarea 
          bind:value={newMessageContent} 
          rows="6" 
          placeholder="Type your message..."
          disabled={sendingMessage}
          class="message-input"
        ></textarea>
      </label>
      <div class="modal-actions">
        <button 
          onclick={() => { showSendMessageDialog = false; newMessageContent = ''; }} 
          class="button-secondary"
          disabled={sendingMessage}
        >
          Cancel
        </button>
        <button 
          onclick={sendMessage} 
          disabled={!newMessageContent.trim() || sendingMessage} 
          class="button-primary"
        >
          {sendingMessage ? 'Sending...' : 'Send'}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .profile-page {
    max-width: 1200px;
    margin: 0 auto;
    padding: 2rem;
  }

  /* Loading & Error States */
  .loading-state,
  .error-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 400px;
    text-align: center;
  }

  .spinner {
    width: 40px;
    height: 40px;
    border: 3px solid var(--border-color);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    margin-bottom: 1rem;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .error-state h2 {
    color: var(--text-primary);
    margin-bottom: 0.5rem;
  }

  /* Profile Header */
  .profile-header {
    display: grid;
    grid-template-columns: auto 1fr auto;
    gap: 2rem;
    align-items: start;
    padding: 2rem;
    background: var(--card-bg);
    border: 1px solid var(--border-color);
    border-radius: 1rem;
    margin-bottom: 2rem;
  }

  .profile-avatar-section {
    position: relative;
  }

  .profile-avatar {
    width: 120px;
    height: 120px;
    border-radius: 50%;
    object-fit: cover;
    border: 3px solid var(--border-color);
  }

  .profile-avatar-placeholder {
    width: 120px;
    height: 120px;
    border-radius: 50%;
    background: var(--accent);
    color: var(--accent-text, #ffffff);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 3rem;
    font-weight: bold;
    border: 3px solid var(--border-color);
  }

  .profile-info {
    flex: 1;
  }

  .profile-name {
    font-size: 2rem;
    font-weight: 700;
    margin: 0 0 0.5rem 0;
    color: var(--text-primary);
  }

  .profile-bio {
    font-size: 1.1rem;
    color: var(--text-secondary);
    margin: 0.5rem 0 1rem 0;
    line-height: 1.6;
  }

  .profile-meta {
    margin-top: 1rem;
  }

  .profile-npub {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 0.875rem;
    color: var(--text-muted);
    background: var(--bg-secondary);
    padding: 0.5rem 0.75rem;
    border-radius: 0.375rem;
    display: inline-block;
  }

  .profile-actions {
    display: flex;
    gap: 0.75rem;
  }

  .action-button {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem 1.5rem;
    background: var(--accent);
    color: var(--accent-text, #ffffff);
    text-decoration: none;
    border-radius: 0.5rem;
    font-weight: 500;
    transition: all 0.2s ease;
  }

  .action-button:hover {
    opacity: 0.9;
    transform: translateY(-1px);
  }

  .action-button .icon-themed {
    width: 18px;
    height: 18px;
  }

  /* Payment Section */
  .payment-section {
    margin-bottom: 2rem;
    padding: 1.5rem;
    background: var(--card-bg);
    border: 1px solid var(--border-color);
    border-radius: 1rem;
  }

  .payment-section h2 {
    margin: 0 0 1rem 0;
    font-size: 1.5rem;
    color: var(--text-primary);
  }

  .payment-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 1rem;
  }

  .payment-card {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 1rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 0.5rem;
    position: relative;
  }

  .payment-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .payment-type {
    font-weight: 600;
    color: var(--text-primary);
    text-transform: capitalize;
  }

  .payment-address {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 0.875rem;
    color: var(--text-secondary);
    word-break: break-all;
    flex: 1;
  }

  .payment-actions {
    position: absolute;
    top: 0.75rem;
    right: 0.75rem;
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }

  .copy-button,
  .lightning-button {
    background: transparent;
    border: 1px solid var(--border-color);
    border-radius: 0.25rem;
    padding: 0.25rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s ease;
  }

  .copy-button:hover,
  .lightning-button:hover {
    background: var(--bg-tertiary);
    border-color: var(--accent);
  }

  .copy-button img,
  .lightning-button img {
    width: 14px;
    height: 14px;
  }

  /* Icon Theming */
  .icon-themed {
    display: block;
    filter: brightness(0) saturate(100%) invert(1) !important; /* Default white for dark themes */
    opacity: 1 !important;
  }

  /* Light theme: black icon */
  :global([data-theme="light"]) .icon-themed {
    filter: brightness(0) saturate(100%) !important; /* Black in light theme */
    opacity: 1 !important;
  }

  /* Dark themes: white icon */
  :global([data-theme="dark"]) .icon-themed,
  :global([data-theme="black"]) .icon-themed {
    filter: brightness(0) saturate(100%) invert(1) !important; /* White in dark themes */
    opacity: 1 !important;
  }

  /* Hover states - icons in buttons should stay visible */
  .action-button:hover .icon-themed {
    filter: brightness(0) saturate(100%) invert(1) !important;
    opacity: 1 !important;
  }

  :global([data-theme="light"]) .action-button:hover .icon-themed {
    filter: brightness(0) saturate(100%) !important;
    opacity: 1 !important;
  }

  .copy-button:hover .icon-themed,
  .lightning-button:hover .icon-themed {
    filter: brightness(0) saturate(100%) invert(1) !important;
    opacity: 1 !important;
  }

  :global([data-theme="light"]) .copy-button:hover .icon-themed,
  :global([data-theme="light"]) .lightning-button:hover .icon-themed {
    filter: brightness(0) saturate(100%) !important;
    opacity: 1 !important;
  }

  /* Tabs */
  .tabs-container {
    margin-bottom: 2rem;
  }

  .tabs {
    display: flex;
    gap: 0.5rem;
    border-bottom: 2px solid var(--border-color);
  }

  .tab {
    padding: 1rem 1.5rem;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
    font-size: 1rem;
    color: var(--text-secondary);
    transition: all 0.2s ease;
    position: relative;
    top: 2px;
  }

  .tab:hover {
    color: var(--text-primary);
    background: var(--bg-secondary);
  }

  .tab.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
    font-weight: 600;
  }

  .tab-count {
    opacity: 0.7;
    font-weight: normal;
  }

  /* Repositories */
  .repo-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 1.5rem;
  }

  .repo-card {
    padding: 1.5rem;
    background: var(--card-bg);
    border: 1px solid var(--border-color);
    border-radius: 0.75rem;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .repo-card:hover {
    border-color: var(--accent);
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  }

  .repo-name {
    font-size: 1.25rem;
    font-weight: 600;
    margin: 0 0 0.5rem 0;
    color: var(--text-primary);
  }

  .repo-description {
    color: var(--text-secondary);
    margin: 0.5rem 0;
    line-height: 1.5;
  }

  .repo-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 1rem;
    padding-top: 1rem;
    border-top: 1px solid var(--border-color);
  }

  .repo-date {
    font-size: 0.875rem;
    color: var(--text-muted);
  }

  /* Messages */
  .messages-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1.5rem;
  }

  .messages-header h2 {
    margin: 0;
    font-size: 1.5rem;
    color: var(--text-primary);
  }

  .send-button {
    padding: 0.75rem 1.5rem;
    background: var(--accent);
    color: var(--accent-text, #ffffff);
    border: none;
    border-radius: 0.5rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .send-button:hover {
    opacity: 0.9;
  }

  .messages-list {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .message-card {
    padding: 1.5rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 0.75rem;
  }

  /* Light theme: even lighter background for better contrast */
  :global([data-theme="light"]) .message-card {
    background: #f5f5f5;
  }

  /* Dark theme: darker background for better contrast */
  :global([data-theme="dark"]) .message-card {
    background: rgba(0, 0, 0, 0.3);
  }

  /* Black theme: gray background (not purple) */
  :global([data-theme="black"]) .message-card {
    background: #1a1a1a;
  }

  .message-card.from-viewer {
    border-color: var(--accent);
  }

  /* Light theme: very subtle muted purple background for viewer messages */
  :global([data-theme="light"]) .message-card.from-viewer {
    background: rgba(138, 43, 226, 0.06);
  }

  /* Dark theme: subtle muted purple background for viewer messages */
  :global([data-theme="dark"]) .message-card.from-viewer {
    background: rgba(138, 43, 226, 0.08);
  }

  /* Black theme: slightly lighter gray with subtle accent border (not purple) */
  :global([data-theme="black"]) .message-card.from-viewer {
    background: #252525;
    border-color: var(--accent);
  }

  .message-card.to-viewer {
    border-left: 4px solid var(--accent);
  }

  .message-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.75rem;
    flex-wrap: wrap;
    gap: 0.75rem;
  }

  .message-participants {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
    flex: 1;
  }

  .participants-label {
    font-size: 0.875rem;
    color: var(--text-muted);
    font-weight: 500;
  }

  .message-time {
    font-size: 0.875rem;
    color: var(--text-muted);
    white-space: nowrap;
  }

  .message-body {
    color: var(--text-primary);
    white-space: pre-wrap;
    word-wrap: break-word;
    line-height: 1.6;
  }

  /* Empty State */
  .empty-state {
    text-align: center;
    padding: 3rem;
    color: var(--text-secondary);
  }

  /* Modal */
  .modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    padding: 1rem;
  }

  .modal {
    background: var(--card-bg);
    border-radius: 1rem;
    padding: 2rem;
    max-width: 500px;
    width: 100%;
    border: 1px solid var(--border-color);
  }

  .modal h3 {
    margin: 0 0 1rem 0;
    font-size: 1.5rem;
    color: var(--text-primary);
  }

  .modal-note {
    color: var(--text-secondary);
    font-size: 0.875rem;
    margin-bottom: 1rem;
    padding: 0.75rem;
    background: var(--bg-secondary);
    border-radius: 0.5rem;
  }

  .message-input {
    width: 100%;
    padding: 0.75rem;
    border: 1px solid var(--border-color);
    border-radius: 0.5rem;
    font-family: inherit;
    font-size: 1rem;
    resize: vertical;
    box-sizing: border-box;
    background: var(--bg-primary);
    color: var(--text-primary);
  }

  .message-input:focus {
    outline: none;
    border-color: var(--accent);
  }

  .modal-actions {
    display: flex;
    gap: 0.75rem;
    justify-content: flex-end;
    margin-top: 1.5rem;
  }

  .button-primary,
  .button-secondary {
    padding: 0.75rem 1.5rem;
    border: none;
    border-radius: 0.5rem;
    font-size: 1rem;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .button-primary {
    background: var(--accent);
    color: var(--accent-text, #ffffff);
  }

  .button-primary:hover:not(:disabled) {
    opacity: 0.9;
  }

  .button-primary:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .button-secondary {
    background: var(--bg-secondary);
    color: var(--text-primary);
    border: 1px solid var(--border-color);
  }

  .button-secondary:hover:not(:disabled) {
    background: var(--bg-tertiary);
  }

  /* Responsive */
  @media (max-width: 768px) {
    .profile-page {
      padding: 1rem;
    }

    .profile-header {
      grid-template-columns: 1fr;
      text-align: center;
    }

    .profile-avatar-section {
      justify-self: center;
    }

    .repo-grid {
      grid-template-columns: 1fr;
    }

    .payment-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
