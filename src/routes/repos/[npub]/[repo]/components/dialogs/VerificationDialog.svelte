<script lang="ts">
  import Modal from './Modal.svelte';
  import type { RepoState } from '../../stores/repo-state.js';

  interface Props {
    open: boolean;
    state: RepoState;
    onCopy: () => void;
    onDownload: () => void;
    onSave?: () => void;
    onClose: () => void;
  }

  let { open, state, onCopy, onDownload, onSave, onClose }: Props = $props();
</script>

<Modal {open} title="Repository Verification File" ariaLabel="Repository verification file" {onClose}>
  <div class="modal-body">
    <p class="verification-instructions">
      The announcement event should be saved to <code class="verification-code">nostr/repo-events.jsonl</code> in your repository.
      You can download the announcement event JSON below for reference.
    </p>
    <div class="verification-file-content">
      <div class="file-header">
        <span class="filename">announcement-event.json</span>
        <div class="file-actions">
          <button onclick={onCopy} class="copy-button">Copy</button>
          <button onclick={onDownload} class="download-button">Download</button>
        </div>
      </div>
      <pre class="file-content"><code>{state.verification.fileContent}</code></pre>
    </div>
  </div>
  <div class="modal-actions">
    {#if onSave}
      <button onclick={onSave} class="save-button" disabled={state.creating.announcement || !state.clone.isCloned}>
        {state.creating.announcement ? 'Saving...' : 'Save to Repo'}
      </button>
    {/if}
    <button onclick={onClose} class="cancel-button">Cancel</button>
  </div>
</Modal>

<style>
  .modal-body {
    margin-bottom: 1rem;
  }

  .verification-instructions {
    margin-bottom: 1rem;
    color: var(--text-secondary, #666);
  }

  .verification-code {
    background: var(--bg-secondary, #f5f5f5);
    color: var(--text-primary);
    padding: 0.2rem 0.4rem;
    border-radius: 3px;
    font-family: monospace;
  }

  .verification-file-content {
    border: 1px solid var(--border-color, #e0e0e0);
    border-radius: 4px;
    overflow: hidden;
  }

  .file-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.75rem;
    background: var(--bg-secondary, #f5f5f5);
    border-bottom: 1px solid var(--border-color, #e0e0e0);
  }

  .filename {
    font-weight: bold;
    font-family: monospace;
    color: var(--text-primary);
  }

  .file-actions {
    display: flex;
    gap: 0.5rem;
  }

  .copy-button,
  .download-button {
    padding: 0.25rem 0.75rem;
    border: 1px solid var(--border-color, #e0e0e0);
    border-radius: 4px;
    background: var(--button-secondary, var(--bg-tertiary));
    color: var(--text-primary);
    cursor: pointer;
    font-family: 'IBM Plex Serif', serif;
    transition: background 0.2s ease, color 0.2s ease;
  }

  .copy-button:hover,
  .download-button:hover {
    background: var(--button-secondary-hover, var(--bg-tertiary));
    opacity: 0.9;
  }

  .file-content {
    margin: 0;
    padding: 1rem;
    overflow-x: auto;
    max-height: 400px;
    overflow-y: auto;
    background: var(--bg-primary);
    color: var(--text-primary);
  }

  .file-content code {
    font-family: monospace;
    font-size: 0.85rem;
    white-space: pre;
    color: var(--text-primary);
  }

  .modal-actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
    margin-top: 1rem;
  }

  .cancel-button {
    padding: 0.5rem 1rem;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    cursor: pointer;
    background: var(--bg-tertiary);
    color: var(--text-primary);
    font-family: 'IBM Plex Serif', serif;
    transition: background 0.2s ease, color 0.2s ease;
  }

  .cancel-button:hover {
    background: var(--bg-secondary);
  }

  .save-button {
    padding: 0.5rem 1rem;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    background: var(--button-primary);
    color: var(--accent-text, #ffffff);
    font-family: 'IBM Plex Serif', serif;
    transition: background 0.2s ease;
  }

  .save-button:hover:not(:disabled) {
    background: var(--button-primary-hover);
  }

  .save-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
