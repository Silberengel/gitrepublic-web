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

<Modal {open} title="Create New Patch" ariaLabel="Create new patch" {onClose}>
  <p class="help-text">Enter your patch content in git format-patch format. Patches should be under 60KB.</p>
  <label>
    Subject (optional):
    <input type="text" bind:value={state.forms.patch.subject} placeholder="Patch title..." />
  </label>
  <label>
    Patch Content:
    <textarea bind:value={state.forms.patch.content} rows="15" placeholder="Paste your git format-patch output here..."></textarea>
  </label>
  <div class="modal-actions">
    <button onclick={onClose} class="cancel-button">Cancel</button>
    <button 
      onclick={onCreate} 
      disabled={!state.forms.patch.content.trim() || state.creating.patch} 
      class="save-button"
    >
      {state.creating.patch ? 'Creating...' : 'Create Patch'}
    </button>
  </div>
</Modal>

<style>
  .help-text {
    margin-bottom: 1rem;
    color: var(--text-secondary, #888);
    font-size: 0.9rem;
  }

  label {
    display: block;
    margin-bottom: 1rem;
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
