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

<Modal {open} title="Create New Issue" ariaLabel="Create new issue" {onClose}>
  <label>
    Subject:
    <input type="text" bind:value={state.forms.issue.subject} placeholder="Issue title..." />
  </label>
  <label>
    Description:
    <textarea bind:value={state.forms.issue.content} rows="10" placeholder="Describe the issue..."></textarea>
  </label>
  <div class="modal-actions">
    <button onclick={onClose} class="cancel-button">Cancel</button>
    <button 
      onclick={onCreate} 
      disabled={!state.forms.issue.subject.trim() || !state.forms.issue.content.trim() || state.saving} 
      class="save-button"
    >
      {state.saving ? 'Creating...' : 'Create Issue'}
    </button>
  </div>
</Modal>

<style>
  label {
    display: block;
    margin-bottom: 1rem;
  }

  label {
    color: var(--text-primary, #e0e0e0);
  }

  label input,
  label textarea {
    width: 100%;
    padding: 0.5rem;
    margin-top: 0.25rem;
    border: 1px solid var(--border-color, #333);
    border-radius: 4px;
    background: var(--bg-secondary, #2a2a2a);
    color: var(--text-primary, #e0e0e0);
  }

  label input::placeholder,
  label textarea::placeholder {
    color: var(--text-secondary, #888);
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
    background: var(--cancel-bg, var(--bg-secondary, #2a2a2a));
    color: var(--text-primary, #e0e0e0);
    border: 1px solid var(--border-color, #333);
  }

  .cancel-button:hover {
    background: var(--bg-hover, #3a3a3a);
  }

  .save-button {
    background: var(--primary-color, var(--accent-color, #2196f3));
    color: white;
  }

  .save-button:hover {
    opacity: 0.9;
  }

  .save-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
