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

<Modal {open} title="Create New Pull Request" ariaLabel="Create new pull request" {onClose}>
  <label>
    Subject:
    <input type="text" bind:value={state.forms.pr.subject} placeholder="PR title..." />
  </label>
  <label>
    Description:
    <textarea bind:value={state.forms.pr.content} rows="8" placeholder="Describe your changes..."></textarea>
  </label>
  <label>
    Commit ID:
    <input type="text" bind:value={state.forms.pr.commitId} placeholder="Commit hash..." />
  </label>
  <label>
    Branch Name (optional):
    <input type="text" bind:value={state.forms.pr.branchName} placeholder="feature/new-feature" />
  </label>
  <div class="modal-actions">
    <button onclick={onClose} class="cancel-button">Cancel</button>
    <button 
      onclick={onCreate} 
      disabled={!state.forms.pr.subject.trim() || !state.forms.pr.content.trim() || !state.forms.pr.commitId.trim() || state.saving} 
      class="save-button"
    >
      {state.saving ? 'Creating...' : 'Create PR'}
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

  .save-button:hover {
    opacity: 0.9;
  }

  .save-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
