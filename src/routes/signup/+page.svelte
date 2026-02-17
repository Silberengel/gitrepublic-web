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
  let webUrls = $state<string[]>(['']);
  let maintainers = $state<string[]>(['']);
  let tags = $state<string[]>(['']);
  let documentation = $state<string[]>(['']);
  let alt = $state('');
  let imageUrl = $state('');
  let bannerUrl = $state('');
  let earliestCommit = $state('');
  let isPrivate = $state(false);
  let isFork = $state(false);
  let forkRepoAddress = $state(''); // a tag: 30617:owner:repo
  let forkOwnerPubkey = $state(''); // p tag: original owner pubkey
  let addClientTag = $state(true); // Add ["client", "gitrepublic-web"] tag
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

  function addWebUrl() {
    webUrls = [...webUrls, ''];
  }

  function removeWebUrl(index: number) {
    webUrls = webUrls.filter((_, i) => i !== index);
  }

  function updateWebUrl(index: number, value: string) {
    const newUrls = [...webUrls];
    newUrls[index] = value;
    webUrls = newUrls;
  }

  function addMaintainer() {
    maintainers = [...maintainers, ''];
  }

  function removeMaintainer(index: number) {
    maintainers = maintainers.filter((_, i) => i !== index);
  }

  function updateMaintainer(index: number, value: string) {
    const newMaintainers = [...maintainers];
    newMaintainers[index] = value;
    maintainers = newMaintainers;
  }

  function addTag() {
    tags = [...tags, ''];
  }

  function removeTag(index: number) {
    tags = tags.filter((_, i) => i !== index);
  }

  function updateTag(index: number, value: string) {
    const newTags = [...tags];
    newTags[index] = value;
    tags = newTags;
  }

  function addDocumentation() {
    documentation = [...documentation, ''];
  }

  function removeDocumentation(index: number) {
    documentation = documentation.filter((_, i) => i !== index);
  }

  function updateDocumentation(index: number, value: string) {
    const newDocs = [...documentation];
    newDocs[index] = value;
    documentation = newDocs;
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
      const imageTag = event.tags.find(t => t[0] === 'image')?.[1] || '';
      const bannerTag = event.tags.find(t => t[0] === 'banner')?.[1] || '';
      const privateTag = event.tags.find(t => (t[0] === 'private' && t[1] === 'true') || (t[0] === 't' && t[1] === 'private'));

      repoName = nameTag || dTag;
      description = descTag;
      imageUrl = imageTag;
      bannerUrl = bannerTag;
      isPrivate = !!privateTag;

      // Extract clone URLs - handle both formats: separate tags and multiple values in one tag
      const urls: string[] = [];
      for (const tag of event.tags) {
        if (tag[0] === 'clone') {
          for (let i = 1; i < tag.length; i++) {
            const url = tag[i];
            if (url && typeof url === 'string' && url.trim()) {
              urls.push(url.trim());
            }
          }
        }
      }
      cloneUrls = urls.length > 0 ? urls : [''];

      // Extract web URLs - handle both formats
      const webUrlsList: string[] = [];
      for (const tag of event.tags) {
        if (tag[0] === 'web') {
          for (let i = 1; i < tag.length; i++) {
            const url = tag[i];
            if (url && typeof url === 'string' && url.trim()) {
              webUrlsList.push(url.trim());
            }
          }
        }
      }
      webUrls = webUrlsList.length > 0 ? webUrlsList : [''];

      // Extract maintainers - handle both formats
      const maintainersList: string[] = [];
      for (const tag of event.tags) {
        if (tag[0] === 'maintainers') {
          for (let i = 1; i < tag.length; i++) {
            const maintainer = tag[i];
            if (maintainer && typeof maintainer === 'string' && maintainer.trim()) {
              maintainersList.push(maintainer.trim());
            }
          }
        }
      }
      maintainers = maintainersList.length > 0 ? maintainersList : [''];

      // Extract tags/labels
      const tagsList: string[] = [];
      for (const tag of event.tags) {
        if (tag[0] === 't' && tag[1] && tag[1] !== 'private' && tag[1] !== 'fork') {
          tagsList.push(tag[1]);
        }
      }
      tags = tagsList.length > 0 ? tagsList : [''];

      // Extract documentation - handle both formats
      const docsList: string[] = [];
      for (const tag of event.tags) {
        if (tag[0] === 'documentation') {
          for (let i = 1; i < tag.length; i++) {
            const doc = tag[i];
            if (doc && typeof doc === 'string' && doc.trim()) {
              docsList.push(doc.trim());
            }
          }
        }
      }
      documentation = docsList.length > 0 ? docsList : [''];

      // Extract alt tag
      const altTag = event.tags.find(t => t[0] === 'alt');
      alt = altTag?.[1] || '';

      // Extract fork information
      const aTag = event.tags.find(t => t[0] === 'a' && t[1]?.startsWith('30617:'));
      forkRepoAddress = aTag?.[1] || '';
      const pTag = event.tags.find(t => t[0] === 'p' && t[1] && t[1] !== event.pubkey);
      forkOwnerPubkey = pTag?.[1] || '';
      isFork = !!(forkRepoAddress || forkOwnerPubkey || event.tags.some(t => t[0] === 't' && t[1] === 'fork'));

      // Extract earliest unique commit
      const rTag = event.tags.find(t => t[0] === 'r' && t[2] === 'euc');
      earliestCommit = rTag?.[1] || '';

      // Check if client tag exists
      addClientTag = !event.tags.some(t => t[0] === 'client' && t[1] === 'gitrepublic-web');

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

      // Build web URLs
      const allWebUrls = webUrls.filter(url => url.trim());

      // Build maintainers list
      const allMaintainers = maintainers.filter(m => m.trim());

      // Build documentation list
      const allDocumentation = documentation.filter(d => d.trim());

      // Build tags/labels (excluding 'private' and 'fork' which are handled separately)
      const allTags = tags.filter(t => t.trim() && t !== 'private' && t !== 'fork');

      // Build event tags - use separate tag for each value (correct format)
      const eventTags: string[][] = [
        ['d', dTag],
        ['name', repoName],
        ...(description ? [['description', description]] : []),
        ...allCloneUrls.map(url => ['clone', url]), // Separate tag per URL
        ...allWebUrls.map(url => ['web', url]), // Separate tag per URL
        ...allMaintainers.map(m => ['maintainers', m]), // Separate tag per maintainer
        ...allDocumentation.map(d => ['documentation', d]), // Separate tag per documentation
        ...allTags.map(t => ['t', t]),
        ...(imageUrl.trim() ? [['image', imageUrl.trim()]] : []),
        ...(bannerUrl.trim() ? [['banner', bannerUrl.trim()]] : []),
        ...(alt.trim() ? [['alt', alt.trim()]] : []),
        ...(earliestCommit.trim() ? [['r', earliestCommit.trim(), 'euc']] : []),
        ...DEFAULT_NOSTR_RELAYS.map(relay => ['relays', relay]) // Separate tag per relay (correct format)
      ];

      // Add fork tags if this is a fork
      if (isFork) {
        if (forkRepoAddress.trim()) {
          eventTags.push(['a', forkRepoAddress.trim()]);
        }
        if (forkOwnerPubkey.trim()) {
          eventTags.push(['p', forkOwnerPubkey.trim()]);
        }
        // Add 'fork' tag if not already in tags
        if (!allTags.includes('fork')) {
          eventTags.push(['t', 'fork']);
        }
      }

      // Add private tag if enabled
      if (isPrivate) {
        eventTags.push(['private', 'true']);
      }

      // Add client tag if enabled
      if (addClientTag) {
        eventTags.push(['client', 'gitrepublic-web']);
      }

      // Build event
      const eventTemplate: Omit<NostrEvent, 'sig' | 'id'> = {
        kind: KIND.REPO_ANNOUNCEMENT,
        pubkey,
        created_at: Math.floor(Date.now() / 1000),
        content: '', // Empty per NIP-34
        tags: eventTags
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
    <h1>Create or Update Repository Announcement</h1>
  </header>

  <main>

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
          <small>Enter a normal name (e.g., "My Awesome Repo"). It will be automatically converted to a d-tag format (lowercase with hyphens, such as my-awesome-repo).</small>
        </label>
        <input
          id="repo-name"
          type="text"
          bind:value={repoName}
          placeholder="My Awesome Repo"
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
          <small>{$page.data.gitDomain || 'localhost:6543'} will be added automatically, but you can add any existing ones here.</small>
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

      <div class="form-group">
        <div class="label">
          Web URLs (optional)
          <small>Webpage URLs for browsing the repository (e.g., GitHub/GitLab web interface)</small>
        </div>
        {#each webUrls as url, index}
          <div class="input-group">
            <input
              type="text"
              value={url}
              oninput={(e) => updateWebUrl(index, e.currentTarget.value)}
              placeholder="https://github.com/user/repo"
              disabled={loading}
            />
            {#if webUrls.length > 1}
              <button
                type="button"
                onclick={() => removeWebUrl(index)}
                disabled={loading}
              >
                Remove
              </button>
            {/if}
          </div>
        {/each}
        <button
          type="button"
          onclick={addWebUrl}
          disabled={loading}
          class="add-button"
        >
          + Add Web URL
        </button>
      </div>

      <div class="form-group">
        <div class="label">
          Maintainers (optional)
          <small>Other maintainer pubkeys (npub or hex format). Example: npub1abc... or hex pubkey</small>
        </div>
        {#each maintainers as maintainer, index}
          <div class="input-group">
            <input
              type="text"
              value={maintainer}
              oninput={(e) => updateMaintainer(index, e.currentTarget.value)}
              placeholder="npub1abc... or hex pubkey"
              disabled={loading}
            />
            {#if maintainers.length > 1}
              <button
                type="button"
                onclick={() => removeMaintainer(index)}
                disabled={loading}
              >
                Remove
              </button>
            {/if}
          </div>
        {/each}
        <button
          type="button"
          onclick={addMaintainer}
          disabled={loading}
          class="add-button"
        >
          + Add Maintainer
        </button>
      </div>

      <div class="form-group">
        <label for="image-url">
          Repository Image URL (optional)
          <small>URL to a repository image/logo. Example: https://example.com/repo-logo.png</small>
        </label>
        <input
          id="image-url"
          type="url"
          bind:value={imageUrl}
          placeholder="https://example.com/repo-logo.png"
          disabled={loading}
        />
      </div>

      <div class="form-group">
        <label for="banner-url">
          Repository Banner URL (optional)
          <small>URL to a repository banner image. Example: https://example.com/repo-banner.png</small>
        </label>
        <input
          id="banner-url"
          type="url"
          bind:value={bannerUrl}
          placeholder="https://example.com/repo-banner.png"
          disabled={loading}
        />
      </div>

      <div class="form-group">
        <label for="earliest-commit">
          Earliest Unique Commit ID (optional)
          <small>Root commit ID or first commit after a permanent fork. Used to identify forks. Example: abc123def456...</small>
        </label>
        <input
          id="earliest-commit"
          type="text"
          bind:value={earliestCommit}
          placeholder="abc123def456..."
          disabled={loading}
        />
      </div>

      <div class="form-group">
        <div class="label">
          Tags/Labels (optional)
          <small>Hashtags or labels for the repository. Examples: "javascript", "web-app", "personal-fork" (indicates author isn't a maintainer)</small>
        </div>
        {#each tags as tag, index}
          <div class="input-group">
            <input
              type="text"
              value={tag}
              oninput={(e) => updateTag(index, e.currentTarget.value)}
              placeholder="javascript"
              disabled={loading}
            />
            {#if tags.length > 1}
              <button
                type="button"
                onclick={() => removeTag(index)}
                disabled={loading}
              >
                Remove
              </button>
            {/if}
          </div>
        {/each}
        <button
          type="button"
          onclick={addTag}
          disabled={loading}
          class="add-button"
        >
          + Add Tag
        </button>
      </div>

      <div class="form-group">
        <label for="alt">
          Alt Text (optional)
          <small>Alternative text/description for the repository. Example: "git repository: Alexandria"</small>
        </label>
        <input
          id="alt"
          type="text"
          bind:value={alt}
          placeholder="git repository: My Awesome Repo"
          disabled={loading}
        />
      </div>

      <div class="form-group">
        <div class="label">
          Documentation (optional)
          <small>Documentation event addresses (naddr format). Example: 30818:pubkey:nkbip-01</small>
        </div>
        {#each documentation as doc, index}
          <div class="input-group">
            <input
              type="text"
              value={doc}
              oninput={(e) => updateDocumentation(index, e.currentTarget.value)}
              placeholder="30818:pubkey:doc-name"
              disabled={loading}
            />
            {#if documentation.length > 1}
              <button
                type="button"
                onclick={() => removeDocumentation(index)}
                disabled={loading}
              >
                Remove
              </button>
            {/if}
          </div>
        {/each}
        <button
          type="button"
          onclick={addDocumentation}
          disabled={loading}
          class="add-button"
        >
          + Add Documentation
        </button>
      </div>

      <div class="form-group">
        <label class="checkbox-label">
          <input
            type="checkbox"
            bind:checked={isFork}
            disabled={loading}
          />
          <div>
            <span>This is a Fork</span>
            <small>Check if this repository is a fork of another repository</small>
          </div>
        </label>
      </div>

      {#if isFork}
        <div class="form-group">
          <label for="fork-repo-address">
            Original Repository Address (optional)
            <small>Repository address of the original repo. Format: 30617:owner-pubkey:repo-name. Example: 30617:abc123...:original-repo</small>
          </label>
          <input
            id="fork-repo-address"
            type="text"
            bind:value={forkRepoAddress}
            placeholder="30617:abc123...:original-repo"
            disabled={loading}
          />
        </div>

        <div class="form-group">
          <label for="fork-owner-pubkey">
            Original Owner Pubkey (optional)
            <small>Pubkey (hex or npub) of the original repository owner. Example: npub1abc... or hex pubkey</small>
          </label>
          <input
            id="fork-owner-pubkey"
            type="text"
            bind:value={forkOwnerPubkey}
            placeholder="npub1abc... or hex pubkey"
            disabled={loading}
          />
        </div>
      {/if}

      <div class="form-group">
        <label class="checkbox-label">
          <input
            type="checkbox"
            bind:checked={isPrivate}
            disabled={loading}
          />
          <div>
            <span>Private Repository</span>
            <small>Mark this repository as private (will be hidden from public listings)</small>
          </div>
        </label>
      </div>

      <div class="form-group">
        <label class="checkbox-label">
          <input
            type="checkbox"
            bind:checked={addClientTag}
            disabled={loading}
          />
          <div>
            <span>Add Client Tag</span>
            <small>Add a client tag to identify this repository as created with GitRepublic (checked by default)</small>
          </div>
        </label>
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

