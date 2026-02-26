<script lang="ts">
  import Modal from './Modal.svelte';
  import type { RepoState } from '../../stores/repo-state.js';

  interface Props {
    open: boolean;
    state: RepoState;
    needsClone: boolean;
    cloneTooltip: string;
    onCreate: () => void;
    onClose: () => void;
  }

  let { open, state, needsClone, cloneTooltip, onCreate, onClose }: Props = $props();
</script>

<Modal {open} title="Create New Tag" ariaLabel="Create new tag" {onClose}>
  <label>
    Tag Name:
    <input type="text" bind:value={state.forms.tag.name} placeholder="v1.0.0" />
  </label>
  <label>
    Reference (commit/branch):
    <input type="text" bind:value={state.forms.tag.ref} placeholder="HEAD" />
  </label>
  <label>
    Message (optional, for annotated tag):
    <textarea bind:value={state.forms.tag.message} rows="3" placeholder="Tag message..."></textarea>
  </label>
  <div class="modal-actions">
    <button onclick={onClose} class="cancel-button">Cancel</button>
    <button 
      onclick={onCreate} 
      disabled={!state.forms.tag.name.trim() || state.saving || needsClone} 
      class="save-button"
      title={needsClone ? cloneTooltip : ''}
    >
      {state.saving ? 'Creating...' : 'Create Tag'}
    </button>
  </div>
</Modal>

<style>
  label {
    display: block;
    margin-bottom: 1rem;
  }

  label input,
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
    background: var(--cancel-bg, #e0e0e0);
  }

  .save-button {
    background: var(--primary-color, #2196f3);
    color: white;
  }

  .save-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
