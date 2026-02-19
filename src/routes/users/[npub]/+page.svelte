<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { NostrClient } from '$lib/services/nostr/nostr-client.js';
  import { DEFAULT_NOSTR_RELAYS, combineRelays } from '$lib/config.js';
  import { KIND } from '$lib/types/nostr.js';
  import { nip19 } from 'nostr-tools';
  import type { NostrEvent } from '$lib/types/nostr.js';
  import { getPublicKeyWithNIP07, isNIP07Available, signEventWithNIP07 } from '$lib/services/nostr/nip07-signer.js';
  import ForwardingConfig from '$lib/components/ForwardingConfig.svelte';
  import { PublicMessagesService, type PublicMessage } from '$lib/services/nostr/public-messages-service.js';
  import { getUserRelays } from '$lib/services/nostr/user-relays.js';
  import UserBadge from '$lib/components/UserBadge.svelte';
  // forwardEventIfEnabled is server-side only - import dynamically if needed
  import { userStore } from '$lib/stores/user-store.js';

  const npub = ($page.params as { npub?: string }).npub || '';

  let loading = $state(true);
  let error = $state<string | null>(null);
  let userPubkey = $state<string | null>(null);
  let viewerPubkeyHex = $state<string | null>(null);
  let lastViewerPubkeyHex = $state<string | null>(null); // Track last viewer pubkey to detect changes
  let isReloading = $state(false); // Guard to prevent concurrent reloads

  // Sync with userStore - only reload if viewer pubkey actually changed
  $effect(() => {
    const currentUser = $userStore;
    const newViewerPubkeyHex = currentUser.userPubkeyHex;
    
    // Only update if viewer pubkey actually changed (not just any store change)
    if (newViewerPubkeyHex !== lastViewerPubkeyHex) {
      const wasLoggedIn = viewerPubkeyHex !== null;
      const isNowLoggedIn = newViewerPubkeyHex !== null;
      
      // Update viewer pubkey
      viewerPubkeyHex = newViewerPubkeyHex;
      lastViewerPubkeyHex = newViewerPubkeyHex;
      
      // Only reload if login state actually changed (logged in -> logged out or vice versa)
      // AND we're not already loading/reloading
      if ((wasLoggedIn !== isNowLoggedIn) && !loading && !isReloading) {
        isReloading = true;
        loadUserProfile()
          .catch(err => console.warn('Failed to reload user profile after login state change:', err))
          .finally(() => {
            isReloading = false;
          });
      }
    }
  });
  let repos = $state<NostrEvent[]>([]);
  let userProfile = $state<{ name?: string; about?: string; picture?: string } | null>(null);
  
  // Messages tab
  let activeTab = $state<'repos' | 'messages'>('repos');
  let messages = $state<PublicMessage[]>([]);
  let loadingMessages = $state(false);
  let showSendMessageDialog = $state(false);
  let newMessageContent = $state('');
  let sendingMessage = $state(false);
  let messagesService: PublicMessagesService | null = null;

  const nostrClient = new NostrClient(DEFAULT_NOSTR_RELAYS);
  const gitDomain = $page.data.gitDomain || 'localhost:6543';

  onMount(async () => {
    await loadViewerPubkey();
    await loadUserProfile();
  });

  // Load messages when messages tab is active
  $effect(() => {
    if (activeTab === 'messages' && userPubkey && messages.length === 0) {
      loadMessages();
    }
  });

  async function loadViewerPubkey() {
    // Check userStore first
    const currentUser = $userStore;
    if (currentUser.userPubkey && currentUser.userPubkeyHex) {
      userPubkey = currentUser.userPubkey;
      viewerPubkeyHex = currentUser.userPubkeyHex;
      return;
    }
    
    // Fallback: try NIP-07 if store doesn't have it
    if (!isNIP07Available()) {
      return;
    }

    try {
      const viewerPubkey = await getPublicKeyWithNIP07();
      userPubkey = viewerPubkey;
      // Convert npub to hex for API calls
      try {
        const decoded = nip19.decode(viewerPubkey);
        if (decoded.type === 'npub') {
          viewerPubkeyHex = decoded.data as string;
        }
      } catch {
        viewerPubkeyHex = viewerPubkey; // Assume it's already hex
      }
    } catch (err) {
      console.warn('Failed to load viewer pubkey:', err);
    }
  }

  async function loadUserProfile() {
    // Prevent concurrent loads
    if (loading && !isReloading) {
      return;
    }
    
    loading = true;
    error = null;

    try {
      // Decode npub to get pubkey (this is the profile owner, not the viewer)
      const decoded = nip19.decode(npub);
      if (decoded.type !== 'npub') {
        error = 'Invalid npub format';
        return;
      }
      const profileOwnerPubkey = decoded.data as string;
      
      // Only update userPubkey if it's different (avoid triggering effects)
      if (userPubkey !== profileOwnerPubkey) {
        userPubkey = profileOwnerPubkey;
      }

      // Fetch user's repositories via API (with privacy filtering)
      const url = `/api/users/${npub}/repos?domain=${encodeURIComponent(gitDomain)}`;
      const response = await fetch(url, {
        headers: viewerPubkeyHex ? {
          'X-User-Pubkey': viewerPubkeyHex
        } : {}
      });

      if (!response.ok) {
        throw new Error(`Failed to load repositories: ${response.statusText}`);
      }

      const data = await response.json();
      repos = data.repos || [];

      // Try to fetch user profile (kind 0)
      const profileEvents = await nostrClient.fetchEvents([
        {
          kinds: [0],
          authors: [userPubkey],
          limit: 1
        }
      ]);

      if (profileEvents.length > 0) {
        try {
          const profile = JSON.parse(profileEvents[0].content);
          userProfile = {
            name: profile.name,
            about: profile.about,
            picture: profile.picture
          };
        } catch {
          // Invalid JSON, ignore
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load user profile';
      console.error('Error loading user profile:', err);
    } finally {
      loading = false;
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

  function getForwardingPubkey(): string | null {
    if (userPubkey && viewerPubkeyHex && viewerPubkeyHex === userPubkey) {
      return userPubkey;
    }
    return null;
  }

  async function loadMessages() {
    if (!userPubkey) return;
    
    loadingMessages = true;
    error = null;
    
    try {
      if (!messagesService) {
        messagesService = new PublicMessagesService(DEFAULT_NOSTR_RELAYS);
      }
      messages = await messagesService.getAllMessagesForUser(userPubkey, 100);
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load messages';
      console.error('Error loading messages:', err);
    } finally {
      loadingMessages = false;
    }
  }

  async function sendMessage() {
    if (!newMessageContent.trim() || !viewerPubkeyHex || !userPubkey) {
      alert('Please enter a message and make sure you are logged in');
      return;
    }

    if (viewerPubkeyHex === userPubkey) {
      alert('You cannot send a message to yourself');
      return;
    }

    sendingMessage = true;
    error = null;

    try {
      if (!messagesService) {
        messagesService = new PublicMessagesService(DEFAULT_NOSTR_RELAYS);
      }
      
      // Create the message event
      const messageEvent = await messagesService.sendPublicMessage(
        viewerPubkeyHex,
        newMessageContent.trim(),
        [{ pubkey: userPubkey }]
      );

      // Get user's relays for publishing
      const { outbox } = await getUserRelays(viewerPubkeyHex, nostrClient);
      const combinedRelays = combineRelays(outbox);

      // Sign the event
      const signedEvent = await signEventWithNIP07(messageEvent);

      // Publish to relays
      const result = await nostrClient.publishEvent(signedEvent, combinedRelays);

      if (result.failed.length > 0 && result.success.length === 0) {
        throw new Error('Failed to publish message to all relays');
      }

      // Forward to messaging platforms if user has unlimited access and preferences configured
      // This is done server-side via API endpoints, not from client
      // The server-side API endpoints (issues, prs, highlights) handle forwarding automatically

      // Reload messages
      await loadMessages();
      
      // Close dialog and clear content
      showSendMessageDialog = false;
      newMessageContent = '';
      
      alert('Message sent successfully!');
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to send message';
      console.error('Error sending message:', err);
      alert(error);
    } finally {
      sendingMessage = false;
    }
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
</script>

<div class="container">
  <header>
    <div class="profile-header">
      {#if userProfile?.picture}
        <img src={userProfile.picture} alt="Profile" class="profile-picture" />
      {:else}
        <div class="profile-picture-placeholder">
          {npub.slice(0, 2).toUpperCase()}
        </div>
      {/if}
      <div class="profile-info">
        <h1>{userProfile?.name || npub.slice(0, 16)}...</h1>
        {#if userProfile?.about}
          <p class="profile-about">{userProfile.about}</p>
        {/if}
        <p class="profile-npub">npub: {npub}</p>
      </div>
    </div>
    {#if getForwardingPubkey()}
      <ForwardingConfig userPubkeyHex={getForwardingPubkey()!} />
      <div class="dashboard-link">
        <a href="/dashboard" class="dashboard-button">
          <img src="/icons/layout-dashboard.svg" alt="Dashboard" class="icon-inline" />
          View Universal Git Dashboard
        </a>
      </div>
    {/if}
  </header>

  <main>
    {#if error}
      <div class="error">Error: {error}</div>
    {/if}

    {#if loading}
      <div class="loading">Loading profile...</div>
    {:else}
      <!-- Tabs -->
      <div class="tabs">
        <button 
          class="tab-button" 
          class:active={activeTab === 'repos'}
          onclick={() => activeTab = 'repos'}
        >
          Repositories ({repos.length})
        </button>
        <button 
          class="tab-button" 
          class:active={activeTab === 'messages'}
          onclick={() => activeTab = 'messages'}
        >
          Messages ({messages.length})
        </button>
      </div>

      <!-- Repositories Tab -->
      {#if activeTab === 'repos'}
        <div class="repos-section">
          <h2>Repositories ({repos.length})</h2>
          {#if repos.length === 0}
            <div class="empty">No repositories found</div>
          {:else}
            <div class="repo-grid">
              {#each repos as event}
                <div 
                  class="repo-card" 
                  role="button"
                  tabindex="0"
                  onclick={() => goto(`/repos/${npub}/${getRepoId(event)}`)}
                  onkeydown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      goto(`/repos/${npub}/${getRepoId(event)}`);
                    }
                  }}
                  style="cursor: pointer;">
                  <h3>{getRepoName(event)}</h3>
                  {#if getRepoDescription(event)}
                    <p class="repo-description">{getRepoDescription(event)}</p>
                  {/if}
                  <div class="repo-meta">
                    <span class="repo-date">
                      {new Date(event.created_at * 1000).toLocaleDateString()}
                    </span>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/if}

      <!-- Messages Tab -->
      {#if activeTab === 'messages'}
        <div class="messages-section">
          <div class="messages-header">
            <h2>Public Messages</h2>
            {#if viewerPubkeyHex && viewerPubkeyHex !== userPubkey}
              <button onclick={() => showSendMessageDialog = true} class="send-message-button">
                Send Message
              </button>
            {/if}
          </div>

          {#if loadingMessages}
            <div class="loading">Loading messages...</div>
          {:else if messages.length === 0}
            <div class="empty">No messages found</div>
          {:else}
            <div class="messages-list">
              {#each messages as message}
                {@const isFromViewer = viewerPubkeyHex !== null && message.pubkey === viewerPubkeyHex}
                {@const isToViewer = viewerPubkeyHex !== null && getMessageRecipients(message).includes(viewerPubkeyHex)}
                {@const isFromUser = userPubkey !== null && message.pubkey === userPubkey}
                {@const isToUser = userPubkey !== null && getMessageRecipients(message).includes(userPubkey)}
                <div class="message-item" class:from-viewer={isFromViewer} class:to-viewer={isToViewer && !isFromViewer}>
                  <div class="message-header">
                    <UserBadge pubkey={message.pubkey} />
                    <span class="message-time">{formatMessageTime(message.created_at)}</span>
                  </div>
                  <div class="message-recipients">
                    {#if getMessageRecipients(message).length > 0}
                      <span class="recipients-label">To:</span>
                      {#each getMessageRecipients(message) as recipientPubkey}
                        <UserBadge pubkey={recipientPubkey} />
                      {/each}
                    {/if}
                  </div>
                  <div class="message-content">{message.content}</div>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    {/if}
  </main>

  <!-- Send Message Dialog -->
  {#if showSendMessageDialog}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div 
        class="modal-overlay" 
        role="dialog"
        aria-modal="true"
        aria-label="Send message"
        onclick={() => showSendMessageDialog = false}
        onkeydown={(e) => e.key === 'Escape' && (showSendMessageDialog = false)}
        tabindex="-1"
      >
      <div 
        class="modal" 
        role="document"
        onclick={(e) => e.stopPropagation()}
      >
        <h3>Send Public Message</h3>
        <p class="modal-note">This message will be publicly visible, but will usually not be displayed outside of notifications.</p>
        <label>
          Message:
          <textarea 
            bind:value={newMessageContent} 
            rows="6" 
            placeholder="Type your message..."
            disabled={sendingMessage}
          ></textarea>
        </label>
        <div class="modal-actions">
          <button 
            onclick={() => { showSendMessageDialog = false; newMessageContent = ''; }} 
            class="cancel-button"
            disabled={sendingMessage}
          >
            Cancel
          </button>
          <button 
            onclick={sendMessage} 
            disabled={!newMessageContent.trim() || sendingMessage} 
            class="send-button"
          >
            {sendingMessage ? 'Sending...' : 'Send Message'}
          </button>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .profile-header {
    display: flex;
    gap: 1.5rem;
    align-items: flex-start;
    margin-bottom: 2rem;
    padding-bottom: 2rem;
    border-bottom: 1px solid var(--border-color);
  }

  .profile-picture {
    width: 80px;
    height: 80px;
    border-radius: 50%;
    object-fit: cover;
  }

  .profile-picture-placeholder {
    width: 80px;
    height: 80px;
    border-radius: 50%;
    background: var(--accent);
    color: var(--accent-text, #ffffff);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 2rem;
    font-weight: bold;
  }

  .profile-about {
    color: var(--text-secondary);
    margin: 0.5rem 0;
  }

  .profile-npub {
    color: var(--text-muted);
    font-size: 0.9rem;
    margin: 0.5rem 0 0 0;
    font-family: 'IBM Plex Mono', monospace;
  }

  .repos-section {
    margin-top: 2rem;
  }

  .repo-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 1.5rem;
  }

  .tabs {
    display: flex;
    gap: 0.5rem;
    border-bottom: 1px solid var(--border-color);
    margin-bottom: 2rem;
  }

  .tab-button {
    padding: 0.75rem 1.5rem;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
    font-size: 1rem;
    color: var(--text-secondary);
    transition: all 0.2s;
  }

  .tab-button:hover {
    color: var(--text-primary);
    background: var(--bg-secondary);
  }

  .tab-button.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
    font-weight: 500;
  }

  .messages-section {
    margin-top: 1rem;
  }

  .messages-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1.5rem;
  }

  .messages-header h2 {
    margin: 0;
  }

  .send-message-button {
    padding: 0.5rem 1rem;
    background: var(--accent);
    color: var(--accent-text, #ffffff);
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.9rem;
    transition: background 0.2s;
  }

  .send-message-button:hover {
    background: var(--accent-dark);
  }

  .messages-list {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .message-item {
    padding: 1rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
  }

  .message-item.from-viewer {
    background: var(--accent-light);
    border-color: var(--accent);
  }

  .message-item.to-viewer {
    border-left: 3px solid var(--accent);
  }

  .message-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.5rem;
  }

  .message-time {
    color: var(--text-muted);
    font-size: 0.85rem;
  }

  .message-recipients {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
    flex-wrap: wrap;
  }

  .recipients-label {
    color: var(--text-muted);
    font-size: 0.85rem;
    font-weight: 500;
  }

  .message-content {
    color: var(--text-primary);
    white-space: pre-wrap;
    word-wrap: break-word;
    line-height: 1.5;
  }

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
  }

  .modal {
    background: var(--card-bg);
    border-radius: 8px;
    padding: 2rem;
    max-width: 500px;
    width: 90%;
    max-height: 90vh;
    overflow-y: auto;
  }

  .modal h3 {
    margin: 0 0 1rem 0;
  }

  .modal-note {
    color: var(--text-secondary);
    font-size: 0.9rem;
    margin-bottom: 1rem;
    padding: 0.75rem;
    background: var(--bg-secondary);
    border-radius: 4px;
  }

  .modal label {
    display: block;
    margin-bottom: 1rem;
  }

  .modal label textarea {
    width: 100%;
    padding: 0.75rem;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    font-family: inherit;
    font-size: 1rem;
    resize: vertical;
    box-sizing: border-box;
  }

  .modal-actions {
    display: flex;
    gap: 0.75rem;
    justify-content: flex-end;
  }

  .cancel-button,
  .send-button {
    padding: 0.5rem 1rem;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.9rem;
  }

  .cancel-button {
    background: var(--bg-secondary);
    color: var(--text-primary);
  }

  .send-button {
    background: var(--accent);
    color: var(--accent-text, #ffffff);
  }

  .send-button:hover:not(:disabled) {
    background: var(--accent-dark);
  }

  .send-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .dashboard-link {
    margin-top: 1rem;
  }

  .dashboard-button {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem 1.5rem;
    background: var(--accent);
    color: var(--accent-text, #ffffff);
    text-decoration: none;
    border-radius: 6px;
    font-size: 0.95rem;
    font-weight: 500;
    transition: background 0.2s;
  }

  .icon-inline {
    width: 16px;
    height: 16px;
    display: inline-block;
    vertical-align: middle;
  }

  .dashboard-button:hover {
    background: var(--accent-dark);
  }
</style>
