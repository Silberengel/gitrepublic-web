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

<Modal {open} title="Create New Branch" ariaLabel="Create new branch" {onClose}>
  {#snippet children()}
    <label>
      Branch Name:
      <input type="text" bind:value={state.forms.branch.name} placeholder="feature/new-feature" />
    </label>
    <label>
      From Branch:
      <select bind:value={state.forms.branch.from}>
        {#if state.git.branches.length === 0}
          <option value={null}>No branches - will create initial branch</option>
        {:else}
          {#each state.git.branches as branch}
            {@const branchName = typeof branch === 'string' ? branch : (branch as { name: string }).name}
            {@const isDefaultBranch = branchName === state.forms.branch.defaultName}
            {#if !isDefaultBranch}
              <option value={branchName}>{branchName}</option>
            {/if}
          {/each}
        {/if}
      </select>
    </label>
    <div class="modal-actions">
      <button onclick={onClose} class="cancel-button">Cancel</button>
      <button 
        onclick={onCreate} 
        disabled={!state.forms.branch.name.trim() || state.saving || needsClone} 
        class="save-button"
        title={needsClone ? cloneTooltip : ''}
      >
        {state.saving ? 'Creating...' : 'Create Branch'}
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
