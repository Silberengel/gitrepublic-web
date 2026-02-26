<script lang="ts">
  import Modal from './Modal.svelte';
  import type { RepoState } from '../../stores/repo-state.js';

  interface Props {
    open: boolean;
    state: RepoState;
    onVerify: () => void;
    onClose: () => void;
  }

  let { open, state, onVerify, onClose }: Props = $props();

  function handleClose() {
    state.verification.selectedCloneUrl = null;
    state.error = null;
    onClose();
  }
</script>

<Modal {open} title="Verify Repository" ariaLabel="Verify repository" onClose={handleClose}>
  <div class="modal-body">
    <p class="verification-instructions">
      Verify this repository by committing the repo announcement event to it.
    </p>
    {#if state.verification.selectedCloneUrl}
      <p style="margin: 1rem 0;">
        <strong>Clone URL:</strong> <code class="verification-code">{state.verification.selectedCloneUrl}</code>
      </p>
    {/if}
    {#if state.clone.isCloned !== true}
      <div class="error-message warning">
        <strong>Repository must be cloned first.</strong> Please clone this repository to the server before verifying ownership.
      </div>
    {:else}
      <p style="margin: 1rem 0; color: var(--text-secondary);">
        This will commit the repository announcement event to <code class="verification-code">nostr/repo-events.jsonl</code> in the default branch, which verifies that you control this repository.
      </p>
    {/if}
    {#if state.error}
      <div class="error-message">
        {state.error}
      </div>
    {/if}
  </div>
  <div class="modal-footer">
    <button 
      onclick={onVerify} 
      class="primary-button"
      disabled={!!state.verification.selectedCloneUrl || !state.clone.isCloned}
      title={!state.clone.isCloned ? 'Repository must be cloned first' : ''}
    >
      {state.verification.selectedCloneUrl ? 'Verifying...' : 'Verify Repository'}
    </button>
    <button 
      onclick={handleClose} 
      class="cancel-button"
      disabled={!!state.verification.selectedCloneUrl}
    >
      Cancel
    </button>
  </div>
</Modal>

<style>
  .modal-body {
    margin-bottom: 1rem;
  }

  .verification-instructions {
    margin-bottom: 1rem;
  }

  .verification-code {
    background: var(--bg-secondary, #f5f5f5);
    padding: 0.2rem 0.4rem;
    border-radius: 3px;
    font-family: monospace;
  }

  .error-message {
    margin: 1rem 0;
    padding: 0.75rem;
    border-radius: 4px;
  }

  .error-message.warning {
    background: var(--bg-warning, #fff3cd);
    border-left: 4px solid var(--text-warning, #856404);
    color: var(--text-warning, #856404);
  }

  .error-message:not(.warning) {
    background: var(--bg-error, #fee);
    border-left: 4px solid var(--accent-error, #f00);
    color: var(--text-error, #c00);
  }

  .modal-footer {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
    margin-top: 1rem;
  }

  .primary-button,
  .cancel-button {
    padding: 0.5rem 1rem;
    border: none;
    border-radius: 4px;
    cursor: pointer;
  }

  .primary-button {
    background: var(--primary-color, #2196f3);
    color: white;
  }

  .primary-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .cancel-button {
    background: var(--cancel-bg, #e0e0e0);
  }

  .cancel-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
