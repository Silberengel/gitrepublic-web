<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { isNIP07Available, getPublicKeyWithNIP07, signEventWithNIP07 } from '../../lib/services/nostr/nip07-signer.js';
  import { decodeNostrAddress } from '../../lib/services/nostr/nip19-utils.js';
  import { NostrClient } from '../../lib/services/nostr/nostr-client.js';
  import { KIND } from '../../lib/types/nostr.js';
  import type { NostrEvent } from '../../lib/types/nostr.js';
  import { nip19 } from 'nostr-tools';

  let nip07Available = $state(false);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let success = $state(false);

  // Form fields
  let repoName = $state('');
  let description = $state('');
  let cloneUrls = $state<string[]>(['']);
  let existingRepoRef = $state(''); // hex, nevent, or naddr
  let loadingExisting = $state(false);

  import { DEFAULT_NOSTR_RELAYS, combineRelays } from '../../lib/config.js';

  const nostrClient = new NostrClient(DEFAULT_NOSTR_RELAYS);

  onMount(() => {
    nip07Available = isNIP07Available();
  });

  function addCloneUrl() {
    cloneUrls = [...cloneUrls, ''];
  }

  function removeCloneUrl(index: number) {
    cloneUrls = cloneUrls.filter((_, i) => i !== index);
  }

  function updateCloneUrl(index: number, value: string) {
    const newUrls = [...cloneUrls];
    newUrls[index] = value;
    cloneUrls = newUrls;
  }

  async function loadExistingRepo() {
    if (!existingRepoRef.trim()) return;

    loadingExisting = true;
    error = null;

    try {
      const decoded = decodeNostrAddress(existingRepoRef.trim());
      if (!decoded) {
        error = 'Invalid format. Please provide a hex event ID, nevent, or naddr.';
        loadingExisting = false;
        return;
      }

      let event: NostrEvent | null = null;

      if (decoded.type === 'note' && decoded.id) {
        // Fetch by event ID
        const events = await nostrClient.fetchEvents([{ ids: [decoded.id], limit: 1 }]);
        event = events[0] || null;
      } else if (decoded.type === 'nevent' && decoded.id) {
        // Fetch by event ID
        const events = await nostrClient.fetchEvents([{ ids: [decoded.id], limit: 1 }]);
        event = events[0] || null;
      } else if (decoded.type === 'naddr' && decoded.pubkey && decoded.kind && decoded.identifier) {
        // Fetch parameterized replaceable event
        const events = await nostrClient.fetchEvents([
          {
            kinds: [decoded.kind],
            authors: [decoded.pubkey],
            '#d': [decoded.identifier],
            limit: 1
          }
        ]);
        event = events[0] || null;
      }

      if (!event) {
        error = 'Repository announcement not found. Make sure it exists on the relays.';
        loadingExisting = false;
        return;
      }

      if (event.kind !== KIND.REPO_ANNOUNCEMENT) {
        error = `The provided event is not a repository announcement (kind ${KIND.REPO_ANNOUNCEMENT}).`;
        loadingExisting = false;
        return;
      }

      // Populate form with existing data
      const dTag = event.tags.find(t => t[0] === 'd')?.[1] || '';
      const nameTag = event.tags.find(t => t[0] === 'name')?.[1] || '';
      const descTag = event.tags.find(t => t[0] === 'description')?.[1] || '';

      repoName = nameTag || dTag;
      description = descTag;

      // Extract clone URLs
      const urls: string[] = [];
      for (const tag of event.tags) {
        if (tag[0] === 'clone') {
          for (let i = 1; i < tag.length; i++) {
            const url = tag[i];
            if (url && typeof url === 'string') {
              urls.push(url);
            }
          }
        }
      }
      cloneUrls = urls.length > 0 ? urls : [''];

    } catch (e) {
      error = `Failed to load repository: ${String(e)}`;
    } finally {
      loadingExisting = false;
    }
  }

  async function submit() {
    if (!nip07Available) {
      error = 'NIP-07 extension is required. Please install a Nostr browser extension.';
      return;
    }

    if (!repoName.trim()) {
      error = 'Repository name is required.';
      return;
    }

    loading = true;
    error = null;

    try {
      const pubkey = await getPublicKeyWithNIP07();
      const npub = nip19.npubEncode(pubkey);

      // Normalize repo name to d-tag format
      const dTag = repoName
        .toLowerCase()
        .trim()
        .replace(/[^\w\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '');

      // Get git domain from layout data
      const gitDomain = $page.data.gitDomain || 'localhost:6543';
      const protocol = gitDomain.startsWith('localhost') ? 'http' : 'https';
      const gitUrl = `${protocol}://${gitDomain}/${npub}/${dTag}.git`;

      // Build clone URLs - always include our domain
      const allCloneUrls = [
        gitUrl,
        ...cloneUrls.filter(url => url.trim() && !url.includes(gitDomain))
      ];

      // Build tags
      const tags: string[][] = [
        ['d', dTag],
        ['name', repoName],
        ...(description ? [['description', description]] : []),
        ...allCloneUrls.map(url => ['clone', url]),
        ['relays', ...DEFAULT_NOSTR_RELAYS]
      ];

      // Build event
      const eventTemplate: Omit<NostrEvent, 'sig' | 'id'> = {
        kind: KIND.REPO_ANNOUNCEMENT,
        pubkey,
        created_at: Math.floor(Date.now() / 1000),
        content: '', // Empty per NIP-34
        tags
      };

      // Sign with NIP-07
      const signedEvent = await signEventWithNIP07(eventTemplate);

      // Get user's inbox/outbox relays (from kind 3 or 10002)
      const { getUserRelays } = await import('../../lib/services/nostr/user-relays.js');
      const { inbox, outbox } = await getUserRelays(pubkey, nostrClient);
      
      // Combine user's outbox with default relays
      const userRelays = combineRelays(outbox);

      // Publish repository announcement
      const result = await nostrClient.publishEvent(signedEvent, userRelays);

      if (result.success.length > 0) {
        // Create and publish initial ownership proof (self-transfer event)
        const { OwnershipTransferService } = await import('../../lib/services/nostr/ownership-transfer-service.js');
        const ownershipService = new OwnershipTransferService(userRelays);
        
        const initialOwnershipEvent = ownershipService.createInitialOwnershipEvent(pubkey, dTag);
        const signedOwnershipEvent = await signEventWithNIP07(initialOwnershipEvent);
        
        // Publish initial ownership event (don't fail if this fails, announcement is already published)
        await nostrClient.publishEvent(signedOwnershipEvent, userRelays).catch(err => {
          console.warn('Failed to publish initial ownership event:', err);
        });

        success = true;
        setTimeout(() => {
          goto('/');
        }, 2000);
      } else {
        error = 'Failed to publish to any relays.';
      }

    } catch (e) {
      error = `Failed to create repository announcement: ${String(e)}`;
    } finally {
      loading = false;
    }
  }
</script>

<div class="container">
  <header>
    <h1>gitrepublic</h1>
    <nav>
      <a href="/">Repositories</a>
      <a href="/signup">Sign Up</a>
    </nav>
  </header>

  <main>
    <h2>Create or Update Repository Announcement</h2>

    {#if !nip07Available}
      <div class="warning">
        <p>NIP-07 browser extension is required to sign repository announcements.</p>
        <p>Please install a Nostr browser extension (like Alby, nos2x, or similar).</p>
      </div>
    {/if}

    {#if error}
      <div class="error">{error}</div>
    {/if}

    {#if success}
      <div class="success">
        Repository announcement published successfully! Redirecting...
      </div>
    {/if}

    <form onsubmit={(e) => { e.preventDefault(); submit(); }}>
      <div class="form-group">
        <label for="existing-repo-ref">
          Load Existing Repository (optional)
          <small>Enter hex event ID, nevent, or naddr to update an existing announcement</small>
        </label>
        <div class="input-group">
          <input
            id="existing-repo-ref"
            type="text"
            bind:value={existingRepoRef}
            placeholder="hex event ID, nevent1..., or naddr1..."
            disabled={loading || loadingExisting}
          />
          <button
            type="button"
            onclick={loadExistingRepo}
            disabled={loading || loadingExisting || !existingRepoRef.trim()}
          >
            {loadingExisting ? 'Loading...' : 'Load'}
          </button>
        </div>
      </div>

      <div class="form-group">
        <label for="repo-name">
          Repository Name *
          <small>Will be used as the d-tag (normalized to lowercase with hyphens)</small>
        </label>
        <input
          id="repo-name"
          type="text"
          bind:value={repoName}
          placeholder="my-awesome-repo"
          required
          disabled={loading}
        />
      </div>

      <div class="form-group">
        <label for="description">
          Description
        </label>
        <textarea
          id="description"
          bind:value={description}
          placeholder="Repository description"
          rows={3}
          disabled={loading}
        ></textarea>
      </div>

      <div class="form-group">
        <div class="label">
          Clone URLs
          <small>{$page.data.gitDomain || 'localhost:6543'} will be added automatically</small>
        </div>
        {#each cloneUrls as url, index}
          <div class="input-group">
            <input
              type="text"
              value={url}
              oninput={(e) => updateCloneUrl(index, e.currentTarget.value)}
              placeholder="https://github.com/user/repo.git"
              disabled={loading}
            />
            {#if cloneUrls.length > 1}
              <button
                type="button"
                onclick={() => removeCloneUrl(index)}
                disabled={loading}
              >
                Remove
              </button>
            {/if}
          </div>
        {/each}
        <button
          type="button"
          onclick={addCloneUrl}
          disabled={loading}
          class="add-button"
        >
          + Add Clone URL
        </button>
      </div>

      <div class="form-actions">
        <button
          type="submit"
          disabled={loading || !nip07Available}
        >
          {loading ? 'Publishing...' : 'Publish Repository Announcement'}
        </button>
        <a href="/" class="cancel-link">Cancel</a>
      </div>
    </form>
  </main>
</div>

