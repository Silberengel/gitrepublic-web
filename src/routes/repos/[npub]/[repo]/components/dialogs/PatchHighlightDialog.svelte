<script lang="ts">
  import Modal from './Modal.svelte';
  import type { RepoState } from '../../stores/repo-state.js';

  interface Props {
    open: boolean;
    state: RepoState;
    onCreate: () => void;
    onClose: () => void;
  }

  let { open, state, onCreate, onClose }: Props = $props();
</script>

<Modal {open} title="Create Highlight" ariaLabel="Create highlight" {onClose}>
  <div class="selected-code">
    <pre><code>{state.forms.patchHighlight.text}</code></pre>
  </div>
  <label>
    Comment (optional):
    <textarea bind:value={state.forms.patchHighlight.comment} rows="4" placeholder="Add a comment about this code..."></textarea>
  </label>
  <div class="modal-actions">
    <button onclick={onClose} class="cancel-button">Cancel</button>
    <button 
      onclick={onCreate} 
      disabled={state.creating.patchHighlight} 
      class="save-button"
    >
      {state.creating.patchHighlight ? 'Creating...' : 'Create Highlight'}
    </button>
  </div>
</Modal>

<style>
  .selected-code {
    margin-bottom: 1rem;
    padding: 0.75rem;
    background: var(--bg-secondary, #f5f5f5);
    border-radius: 4px;
    overflow-x: auto;
  }

  .selected-code pre {
    margin: 0;
  }

  .selected-code code {
    font-family: monospace;
    font-size: 0.9rem;
  }

  label {
    display: block;
    margin-bottom: 1rem;
  }

  label textarea {
    width: 100%;
    padding: 0.5rem;
    margin-top: 0.25rem;
    border: 1px solid var(--border-color, #e0e0e0);
    border-radius: 4px;
  }

  .modal-actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
    margin-top: 1rem;
  }

  .cancel-button,
  .save-button {
    padding: 0.5rem 1rem;
    border: none;
    border-radius: 4px;
    cursor: pointer;
  }

  .cancel-button {
    background: var(--bg-tertiary);
    border: 1px solid var(--border-color);
    color: var(--text-primary);
    font-family: 'IBM Plex Serif', serif;
    transition: background 0.2s ease, color 0.2s ease;
  }

  .cancel-button:hover {
    background: var(--bg-secondary);
  }

  .save-button {
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
