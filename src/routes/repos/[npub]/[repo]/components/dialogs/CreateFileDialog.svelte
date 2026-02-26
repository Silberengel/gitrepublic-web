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

<Modal {open} title="Create New File" ariaLabel="Create new file" {onClose}>
  {#snippet children()}
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
      File Name:
      <input type="text" bind:value={state.forms.file.fileName} placeholder="filename.md" />
    </label>
    <label>
      Content:
      <textarea bind:value={state.forms.file.content} rows="10" placeholder="File content..."></textarea>
    </label>
    <div class="modal-actions">
      <button onclick={onClose} class="cancel-button">Cancel</button>
      <button 
        onclick={onCreate} 
        disabled={!state.forms.file.fileName.trim() || state.saving || needsClone || !state.git.currentBranch} 
        class="save-button"
        title={needsClone ? cloneTooltip : (!state.git.currentBranch ? 'Please select a branch' : '')}
      >
        {state.saving ? 'Creating...' : 'Create'}
      </button>
    </div>
  {/snippet}
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
