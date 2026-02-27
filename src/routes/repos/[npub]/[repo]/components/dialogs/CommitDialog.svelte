<script lang="ts">
  import Modal from './Modal.svelte';
  import type { RepoState } from '../../stores/repo-state.js';

  interface Props {
    open: boolean;
    state: RepoState;
    needsClone: boolean;
    cloneTooltip: string;
    onCommit: () => void;
    onClose: () => void;
  }

  let { open, state, needsClone, cloneTooltip, onCommit, onClose }: Props = $props();
</script>

<Modal {open} title="Commit Changes" ariaLabel="Commit changes" {onClose}>
  {#if state.git.branches.length > 0}
    <label>
      Branch:
      <select bind:value={state.git.currentBranch} disabled={state.saving}>
        {#each state.git.branches as branch}
          {@const branchName = typeof branch === 'string' ? branch : branch.name}
          <option value={branchName}>{branchName}{#if branchName === state.git.defaultBranch} (default){/if}</option>
        {/each}
      </select>
    </label>
  {:else if state.git.currentBranch}
    <label>
      Branch:
      <input type="text" value={state.git.currentBranch} disabled />
    </label>
  {/if}
  <label>
    Commit Message:
    <textarea 
      bind:value={state.forms.commit.message} 
      placeholder="Describe your changes..."
      rows="4"
    ></textarea>
  </label>
  <div class="modal-actions">
    <button onclick={onClose} class="cancel-button">Cancel</button>
    <button 
      onclick={onCommit} 
      disabled={!state.forms.commit.message.trim() || state.saving || needsClone || !state.git.currentBranch} 
      class="save-button"
      title={needsClone ? cloneTooltip : (!state.git.currentBranch ? 'Please select a branch' : '')}
    >
      {state.saving ? 'Saving...' : 'Commit & Save'}
    </button>
  </div>
</Modal>

<style>
  label {
    display: block;
    margin-bottom: 1rem;
  }

  label input,
  label textarea,
  label select {
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
