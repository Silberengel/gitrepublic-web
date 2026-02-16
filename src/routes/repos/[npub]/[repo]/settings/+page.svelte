<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { getPublicKeyWithNIP07 } from '$lib/services/nostr/nip07-signer.js';

  const npub = ($page.params as { npub?: string; repo?: string }).npub || '';
  const repo = ($page.params as { npub?: string; repo?: string }).repo || '';

  let loading = $state(true);
  let saving = $state(false);
  let error = $state<string | null>(null);
  let userPubkey = $state<string | null>(null);
  
  let name = $state('');
  let description = $state('');
  let cloneUrls = $state<string[]>(['']);
  let maintainers = $state<string[]>(['']);
  let isPrivate = $state(false);

  onMount(async () => {
    await checkAuth();
    await loadSettings();
  });

  async function checkAuth() {
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
</script>

<div class="container">
  <header>
    <a href={`/repos/${npub}/${repo}`} class="back-link">← Back to Repository</a>
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

<style>
  .container {
    max-width: 800px;
    margin: 0 auto;
    padding: 2rem;
  }

  .back-link {
    display: inline-block;
    margin-bottom: 1rem;
    color: #007bff;
    text-decoration: none;
  }

  .back-link:hover {
    text-decoration: underline;
  }

  .settings-form {
    background: white;
    border-radius: 8px;
    padding: 2rem;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
  }

  .form-section {
    margin-bottom: 2rem;
    padding-bottom: 2rem;
    border-bottom: 1px solid #e0e0e0;
  }

  .form-section:last-of-type {
    border-bottom: none;
  }

  .form-section h2 {
    margin-bottom: 1rem;
    color: #333;
  }

  label {
    display: block;
    margin-bottom: 1rem;
    font-weight: 500;
  }

  label input[type="text"],
  label input[type="url"],
  label textarea {
    width: 100%;
    padding: 0.75rem;
    border: 1px solid #ddd;
    border-radius: 4px;
    font-size: 1rem;
    margin-top: 0.5rem;
  }

  label input[type="checkbox"] {
    margin-right: 0.5rem;
  }

  .help-text {
    color: #666;
    font-size: 0.9rem;
    margin-bottom: 1rem;
  }

  .array-input {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
    align-items: center;
  }

  .array-input input {
    flex: 1;
  }

  .add-button, .remove-button {
    padding: 0.5rem 1rem;
    border: 1px solid #ddd;
    border-radius: 4px;
    background: white;
    cursor: pointer;
    font-size: 0.9rem;
  }

  .add-button {
    color: #007bff;
    border-color: #007bff;
  }

  .add-button:hover {
    background: #f0f8ff;
  }

  .remove-button {
    color: #d32f2f;
    border-color: #d32f2f;
  }

  .remove-button:hover {
    background: #ffebee;
  }

  .form-actions {
    display: flex;
    gap: 1rem;
    justify-content: flex-end;
    margin-top: 2rem;
  }

  .cancel-button, .save-button {
    padding: 0.75rem 1.5rem;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 1rem;
  }

  .cancel-button {
    background: #f5f5f5;
    color: #333;
  }

  .cancel-button:hover {
    background: #e0e0e0;
  }

  .save-button {
    background: #007bff;
    color: white;
  }

  .save-button:hover:not(:disabled) {
    background: #0056b3;
  }

  .save-button:disabled {
    background: #ccc;
    cursor: not-allowed;
  }

  .loading, .error {
    text-align: center;
    padding: 2rem;
  }

  .error {
    color: #d32f2f;
    background: #ffebee;
    border-radius: 4px;
  }
</style>
