<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { getPublicKeyWithNIP07 } from '$lib/services/nostr/nip07-signer.js';
  import { userStore } from '$lib/stores/user-store.js';

  const npub = ($page.params as { npub?: string; repo?: string }).npub || '';
  const repo = ($page.params as { npub?: string; repo?: string }).repo || '';

  let loading = $state(true);
  let saving = $state(false);
  let error = $state<string | null>(null);
  let userPubkey = $state<string | null>(null);

  // Sync with userStore
  $effect(() => {
    const currentUser = $userStore;
    if (currentUser.userPubkey) {
      userPubkey = currentUser.userPubkey;
    } else {
      userPubkey = null;
    }
  });
  
  let name = $state('');
  let description = $state('');
  let cloneUrls = $state<string[]>(['']);
  let maintainers = $state<string[]>(['']);
  let chatRelays = $state<string[]>(['']);
  let isPrivate = $state(false);

  onMount(async () => {
    await checkAuth();
    await loadSettings();
  });

  async function checkAuth() {
    // Check userStore first
    const currentUser = $userStore;
    if (currentUser.userPubkey) {
      userPubkey = currentUser.userPubkey;
      return;
    }
    
    // Fallback: try NIP-07 if store doesn't have it
    try {
      if (typeof window !== 'undefined' && window.nostr) {
        userPubkey = await getPublicKeyWithNIP07();
      }
    } catch (err) {
      console.error('Auth check failed:', err);
    }
  }

  async function loadSettings() {
    loading = true;
    error = null;

    try {
      const response = await fetch(`/api/repos/${npub}/${repo}/settings?userPubkey=${userPubkey}`);
      if (response.ok) {
        const data = await response.json();
        name = data.name || '';
        description = data.description || '';
        cloneUrls = data.cloneUrls?.length > 0 ? data.cloneUrls : [''];
        maintainers = data.maintainers?.length > 0 ? data.maintainers : [''];
        chatRelays = data.chatRelays?.length > 0 ? data.chatRelays : [''];
        isPrivate = data.isPrivate || false;
      } else {
        const data = await response.json();
        error = data.error || 'Failed to load settings';
        if (response.status === 403) {
          setTimeout(() => goto(`/repos/${npub}/${repo}`), 2000);
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load settings';
    } finally {
      loading = false;
    }
  }

  async function saveSettings() {
    if (!userPubkey) {
      error = 'Please connect your NIP-07 extension';
      return;
    }

    saving = true;
    error = null;

    try {
      const response = await fetch(`/api/repos/${npub}/${repo}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userPubkey,
          name,
          description,
          cloneUrls: cloneUrls.filter(url => url.trim()),
          maintainers: maintainers.filter(m => m.trim()),
          chatRelays: chatRelays.filter(url => url.trim()),
          isPrivate
        })
      });

      if (response.ok) {
        alert('Settings saved successfully!');
        goto(`/repos/${npub}/${repo}`);
      } else {
        const data = await response.json();
        error = data.error || 'Failed to save settings';
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to save settings';
    } finally {
      saving = false;
    }
  }

  function addCloneUrl() {
    cloneUrls = [...cloneUrls, ''];
  }

  function removeCloneUrl(index: number) {
    cloneUrls = cloneUrls.filter((_, i) => i !== index);
  }

  function addMaintainer() {
    maintainers = [...maintainers, ''];
  }

  function removeMaintainer(index: number) {
    maintainers = maintainers.filter((_, i) => i !== index);
  }

  function addChatRelay() {
    chatRelays = [...chatRelays, ''];
  }

  function removeChatRelay(index: number) {
    chatRelays = chatRelays.filter((_, i) => i !== index);
  }
</script>

<div class="container">
  <header>
    <h1>Repository Settings</h1>
  </header>

  <main>
    {#if loading}
      <div class="loading">Loading settings...</div>
    {:else if error && !userPubkey}
      <div class="error">
        {error}
        <p>Redirecting to repository...</p>
      </div>
    {:else}
      <form onsubmit={(e) => { e.preventDefault(); saveSettings(); }} class="settings-form">
        <div class="form-section">
          <h2>Basic Information</h2>
          
          <label>
            Repository Name
            <input type="text" bind:value={name} required />
          </label>

          <label>
            Description
            <textarea bind:value={description} rows="3"></textarea>
          </label>

          <label>
            <input type="checkbox" bind:checked={isPrivate} />
            Private Repository (only owners and maintainers can view)
          </label>
        </div>

        <div class="form-section">
          <h2>Clone URLs</h2>
          <p class="help-text">Additional clone URLs (your server URL is automatically included)</p>
          {#each cloneUrls as url, index}
            <div class="array-input">
              <input type="url" bind:value={cloneUrls[index]} placeholder="https://example.com/repo.git" />
              {#if cloneUrls.length > 1}
                <button type="button" onclick={() => removeCloneUrl(index)} class="remove-button">Remove</button>
              {/if}
            </div>
          {/each}
          <button type="button" onclick={addCloneUrl} class="add-button">+ Add Clone URL</button>
        </div>

        <div class="form-section">
          <h2>Maintainers</h2>
          <p class="help-text">Additional maintainers (npub or hex pubkey)</p>
          {#each maintainers as maintainer, index}
            <div class="array-input">
              <input type="text" bind:value={maintainers[index]} placeholder="npub1..." />
              {#if maintainers.length > 1}
                <button type="button" onclick={() => removeMaintainer(index)} class="remove-button">Remove</button>
              {/if}
            </div>
          {/each}
          <button type="button" onclick={addMaintainer} class="add-button">+ Add Maintainer</button>
        </div>

        <div class="form-section">
          <h2>Chat Relays</h2>
          <p class="help-text">WebSocket relays for kind 11 discussion threads (e.g., wss://myprojechat.com, ws://localhost:2937)</p>
          {#each chatRelays as relay, index}
            <div class="array-input">
              <input type="text" bind:value={chatRelays[index]} placeholder="wss://example.com" />
              {#if chatRelays.length > 1}
                <button type="button" onclick={() => removeChatRelay(index)} class="remove-button">Remove</button>
              {/if}
            </div>
          {/each}
          <button type="button" onclick={addChatRelay} class="add-button">+ Add Chat Relay</button>
        </div>

        {#if error}
          <div class="error">{error}</div>
        {/if}

        <div class="form-actions">
          <button type="button" onclick={() => goto(`/repos/${npub}/${repo}`)} class="cancel-button">Cancel</button>
          <button type="submit" disabled={saving} class="save-button">
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
        </div>
      </form>
    {/if}
  </main>
</div>

