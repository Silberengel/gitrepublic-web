<script lang="ts">
  import Modal from './Modal.svelte';
  import type { RepoState } from '../../stores/repo-state.js';

  interface Props {
    open: boolean;
    state: RepoState;
    onCopy: () => void;
    onDownload: () => void;
    onClose: () => void;
  }

  let { open, state, onCopy, onDownload, onClose }: Props = $props();
</script>

<Modal {open} title="Repository Verification File" ariaLabel="Repository verification file" {onClose}>
  <div class="modal-body">
    <p class="verification-instructions">
      The announcement event should be saved to <code>nostr/repo-events.jsonl</code> in your repository.
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
    <button onclick={onClose} class="cancel-button">Close</button>
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

  .verification-instructions code {
    background: var(--bg-secondary, #f5f5f5);
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
    background: white;
    cursor: pointer;
  }

  .file-content {
    margin: 0;
    padding: 1rem;
    overflow-x: auto;
    max-height: 400px;
    overflow-y: auto;
  }

  .file-content code {
    font-family: monospace;
    font-size: 0.85rem;
    white-space: pre;
  }

  .modal-actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
    margin-top: 1rem;
  }

  .cancel-button {
    padding: 0.5rem 1rem;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    background: var(--cancel-bg, #e0e0e0);
  }
</style>
