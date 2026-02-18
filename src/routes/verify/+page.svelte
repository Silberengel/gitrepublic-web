<script lang="ts">
  import { onMount } from 'svelte';
  import { NostrClient } from '$lib/services/nostr/nostr-client.js';
  import { DEFAULT_NOSTR_RELAYS } from '$lib/config.js';
  import { KIND } from '$lib/types/nostr.js';
  import { generateVerificationFile, VERIFICATION_FILE_PATH } from '$lib/services/nostr/repo-verification.js';
  import { nip19 } from 'nostr-tools';
  import type { NostrEvent } from '$lib/types/nostr.js';

  let npub = $state('');
  let repoName = $state('');
  let loading = $state(false);
  let error = $state<string | null>(null);
  let verificationContent = $state<string | null>(null);
  let announcementEvent = $state<NostrEvent | null>(null);

  const nostrClient = new NostrClient(DEFAULT_NOSTR_RELAYS);

  async function generateVerification() {
    if (!npub.trim() || !repoName.trim()) {
      error = 'Please enter both npub and repository name';
      return;
    }

    loading = true;
    error = null;
    verificationContent = null;
    announcementEvent = null;

    try {
      // Decode npub to get pubkey
      let ownerPubkey: string;
      try {
        const decoded = nip19.decode(npub.trim());
        if (decoded.type !== 'npub') {
          error = 'Invalid npub format';
          loading = false;
          return;
        }
        ownerPubkey = decoded.data as string;
      } catch (err) {
        error = `Failed to decode npub: ${err instanceof Error ? err.message : String(err)}`;
        loading = false;
        return;
      }

      // Fetch repository announcement from Nostr
      const events = await nostrClient.fetchEvents([
        {
          kinds: [KIND.REPO_ANNOUNCEMENT],
          authors: [ownerPubkey],
          '#d': [repoName.trim()],
          limit: 1
        }
      ]);

      if (events.length === 0) {
        error = `No repository announcement found for ${npub}/${repoName.trim()}. Make sure you've published the repository announcement to Nostr.`;
        loading = false;
        return;
      }

      const announcement = events[0] as NostrEvent;
      announcementEvent = announcement;

      // Generate verification file content
      verificationContent = generateVerificationFile(announcement, ownerPubkey);
    } catch (err) {
      error = `Failed to generate verification file: ${err instanceof Error ? err.message : String(err)}`;
      console.error('Error generating verification:', err);
    } finally {
      loading = false;
    }
  }

  function copyToClipboard() {
    if (!verificationContent) return;
    
    navigator.clipboard.writeText(verificationContent).then(() => {
      alert('Verification file content copied to clipboard!');
    }).catch((err) => {
      console.error('Failed to copy:', err);
      alert('Failed to copy to clipboard. Please select and copy manually.');
    });
  }

  function downloadFile() {
    if (!verificationContent) return;
    
    const blob = new Blob([verificationContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = VERIFICATION_FILE_PATH;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
</script>

<svelte:head>
  <title>Generate Repository Verification File - GitRepublic</title>
</svelte:head>

<div class="verify-container">
  <div class="verify-content">
    <h1>Generate Repository Verification File</h1>
    <p class="description">
      This tool helps you generate a verification file for a repository that isn't saved to the server yet.
      The verification file proves ownership by linking your Nostr repository announcement to your git repository.
    </p>

    <div class="form-section">
      <h2>Repository Information</h2>
      <form onsubmit={(e) => { e.preventDefault(); generateVerification(); }}>
        <div class="form-group">
          <label for="npub">Repository Owner (npub):</label>
          <input
            id="npub"
            type="text"
            bind:value={npub}
            placeholder="npub1..."
            disabled={loading}
            required
          />
          <small>Your Nostr public key in npub format</small>
        </div>

        <div class="form-group">
          <label for="repo">Repository Name:</label>
          <input
            id="repo"
            type="text"
            bind:value={repoName}
            placeholder="my-repo"
            disabled={loading}
            required
          />
          <small>The repository identifier (d-tag) from your announcement</small>
        </div>

        <button type="submit" disabled={loading || !npub.trim() || !repoName.trim()} class="generate-button">
          {loading ? 'Generating...' : 'Generate Verification File'}
        </button>
      </form>
    </div>

    {#if error}
      <div class="error-message">
        <strong>Error:</strong> {error}
      </div>
    {/if}

    {#if verificationContent}
      <div class="verification-section">
        <h2>Verification File Generated</h2>
        <p class="instructions">
          <strong>Next steps:</strong>
        </p>
        <ol class="steps">
          <li>Copy the verification file content below</li>
          <li>Create a file named <code>{VERIFICATION_FILE_PATH}</code> in the root of your git repository</li>
          <li>Paste the content into that file</li>
          <li>Commit and push the file to your repository</li>
          <li>Once the repository is saved to the server, verification will be automatic</li>
        </ol>

        {#if announcementEvent}
          <div class="announcement-info">
            <h3>Announcement Details</h3>
            <ul>
              <li><strong>Event ID:</strong> <code>{announcementEvent.id}</code></li>
              <li><strong>Created:</strong> {new Date(announcementEvent.created_at * 1000).toLocaleString()}</li>
            </ul>
          </div>
        {/if}

        <div class="verification-file">
          <div class="file-header">
            <span class="filename">{VERIFICATION_FILE_PATH}</span>
            <div class="file-actions">
              <button onclick={copyToClipboard} class="copy-button">Copy</button>
              <button onclick={downloadFile} class="download-button">Download</button>
            </div>
          </div>
          <pre class="file-content"><code>{verificationContent}</code></pre>
        </div>
      </div>
    {/if}

    <div class="info-section">
      <h2>About Verification</h2>
      <p>
        Repository verification proves that you own both the Nostr repository announcement and the git repository.
        There are two methods:
      </p>
      <ul>
        <li><strong>Self-transfer event</strong> (preferred): A Nostr event that transfers ownership to yourself, proving you control the private key.</li>
        <li><strong>Verification file</strong> (this method): A file in your repository containing the announcement event ID and signature.</li>
      </ul>
      <p>
        The verification file method is useful when your repository isn't on the server yet, as you can generate
        the file and commit it to your repository before the server fetches it.
      </p>
    </div>
  </div>
</div>

<style>
  .verify-container {
    max-width: 900px;
    margin: 2rem auto;
    padding: 0 1rem;
  }

  .verify-content {
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 0.5rem;
    padding: 2rem;
  }

  h1 {
    margin-top: 0;
    color: var(--text-primary);
  }

  .description {
    color: var(--text-secondary);
    margin-bottom: 2rem;
    line-height: 1.6;
  }

  .form-section {
    margin-bottom: 2rem;
  }

  .form-section h2 {
    margin-top: 0;
    margin-bottom: 1rem;
    color: var(--text-primary);
    font-size: 1.25rem;
  }

  .form-group {
    margin-bottom: 1.5rem;
  }

  .form-group label {
    display: block;
    margin-bottom: 0.5rem;
    color: var(--text-primary);
    font-weight: 500;
  }

  .form-group input {
    width: 100%;
    padding: 0.75rem;
    border: 1px solid var(--border-color);
    border-radius: 0.375rem;
    background: var(--bg-secondary);
    color: var(--text-primary);
    font-size: 1rem;
    font-family: monospace;
  }

  .form-group input:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .form-group input:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px rgba(0, 0, 0, 0.1);
  }

  .form-group small {
    display: block;
    margin-top: 0.25rem;
    color: var(--text-secondary);
    font-size: 0.875rem;
  }

  .generate-button {
    padding: 0.75rem 1.5rem;
    background: var(--accent);
    color: var(--accent-text, white);
    border: none;
    border-radius: 0.375rem;
    font-size: 1rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .generate-button:hover:not(:disabled) {
    opacity: 0.9;
    transform: translateY(-1px);
  }

  .generate-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .error-message {
    padding: 1rem;
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.3);
    border-radius: 0.375rem;
    color: #dc2626;
    margin-bottom: 2rem;
  }

  .verification-section {
    margin-top: 2rem;
    padding-top: 2rem;
    border-top: 1px solid var(--border-color);
  }

  .verification-section h2 {
    margin-top: 0;
    color: var(--text-primary);
  }

  .instructions {
    color: var(--text-primary);
    margin-bottom: 1rem;
  }

  .steps {
    color: var(--text-primary);
    margin-bottom: 2rem;
    padding-left: 1.5rem;
  }

  .steps li {
    margin-bottom: 0.5rem;
    line-height: 1.6;
  }

  .steps code {
    background: var(--bg-secondary);
    padding: 0.125rem 0.375rem;
    border-radius: 0.25rem;
    font-family: monospace;
    color: var(--accent);
  }

  .announcement-info {
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 0.375rem;
    padding: 1rem;
    margin-bottom: 1.5rem;
  }

  .announcement-info h3 {
    margin-top: 0;
    margin-bottom: 0.75rem;
    color: var(--text-primary);
    font-size: 1rem;
  }

  .announcement-info ul {
    margin: 0;
    padding-left: 1.5rem;
    color: var(--text-primary);
  }

  .announcement-info li {
    margin-bottom: 0.5rem;
  }

  .announcement-info code {
    background: var(--bg-primary);
    padding: 0.125rem 0.375rem;
    border-radius: 0.25rem;
    font-family: monospace;
    font-size: 0.875rem;
    word-break: break-all;
  }

  .verification-file {
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 0.375rem;
    overflow: hidden;
  }

  .file-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.75rem 1rem;
    background: var(--bg-tertiary);
    border-bottom: 1px solid var(--border-color);
  }

  .filename {
    font-family: monospace;
    font-weight: 500;
    color: var(--text-primary);
  }

  .file-actions {
    display: flex;
    gap: 0.5rem;
  }

  .copy-button,
  .download-button {
    padding: 0.375rem 0.75rem;
    background: var(--bg-primary);
    color: var(--text-primary);
    border: 1px solid var(--border-color);
    border-radius: 0.25rem;
    font-size: 0.875rem;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .copy-button:hover,
  .download-button:hover {
    background: var(--bg-secondary);
    border-color: var(--accent);
  }

  .file-content {
    margin: 0;
    padding: 1rem;
    overflow-x: auto;
    background: var(--bg-primary);
  }

  .file-content code {
    font-family: 'Courier New', monospace;
    font-size: 0.875rem;
    color: var(--text-primary);
    white-space: pre;
  }

  .info-section {
    margin-top: 3rem;
    padding-top: 2rem;
    border-top: 1px solid var(--border-color);
  }

  .info-section h2 {
    margin-top: 0;
    color: var(--text-primary);
  }

  .info-section p,
  .info-section ul {
    color: var(--text-secondary);
    line-height: 1.6;
  }

  .info-section ul {
    margin-top: 0.5rem;
    padding-left: 1.5rem;
  }

  .info-section li {
    margin-bottom: 0.5rem;
  }

  .info-section strong {
    color: var(--text-primary);
  }
</style>
