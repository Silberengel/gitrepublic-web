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

<Modal {open} title="Create New Release" ariaLabel="Create new release" {onClose}>
  <label>
    Title:
    <input type="text" bind:value={state.forms.release.title} placeholder="Release title (e.g., Version 1.0.0)" />
  </label>
  <label>
    Tag Name:
    <input type="text" bind:value={state.forms.release.tagName} placeholder="v1.0.0" />
  </label>
  <label>
    Tag Hash (commit hash):
    <input type="text" bind:value={state.forms.release.tagHash} placeholder="abc1234..." />
  </label>
  <label>
    Download URL (optional):
    <input type="url" bind:value={state.forms.release.downloadUrl} placeholder="/api/repos/.../archive?ref=..." />
    <small class="field-hint">Pre-filled with the ZIP download URL for this tag. You can change it if needed.</small>
  </label>
  <label>
    Release Notes:
    <textarea bind:value={state.forms.release.notes} rows="10" placeholder="Release notes in markdown..."></textarea>
  </label>
  <label class="checkbox-label">
    <input type="checkbox" bind:checked={state.forms.release.isDraft} />
    <div class="checkbox-content">
      <span class="checkbox-title">Draft Release</span>
      <span class="checkbox-explanation">Published but marked as draft. Viewers can filter it out, but it's still visible on Nostr relays.</span>
    </div>
  </label>
  <label class="checkbox-label">
    <input type="checkbox" bind:checked={state.forms.release.isPrerelease} />
    <div class="checkbox-content">
      <span class="checkbox-title">Pre-release</span>
      <span class="checkbox-explanation">Marks this as a pre-release (alpha, beta, or release candidate), not the final stable version.</span>
    </div>
  </label>
  <div class="modal-actions">
    <button onclick={onClose} class="cancel-button">Cancel</button>
    <button 
      onclick={onCreate} 
      disabled={!state.forms.release.tagName.trim() || !state.forms.release.tagHash.trim() || state.creating.release} 
      class="save-button"
    >
      {state.creating.release ? 'Creating...' : 'Create Release'}
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

  label input[type="checkbox"] {
    width: auto;
    margin-right: 0.5rem;
  }

  .checkbox-label {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
  }

  .checkbox-label input[type="checkbox"] {
    margin-top: 0.25rem;
    flex-shrink: 0;
  }

  .checkbox-content {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    flex: 1;
  }

  .checkbox-title {
    font-weight: 500;
    color: var(--text-primary);
  }

  .checkbox-explanation {
    font-size: 0.875rem;
    color: var(--text-secondary);
    line-height: 1.4;
  }

  .field-hint {
    display: block;
    margin-top: 0.25rem;
    font-size: 0.875rem;
    color: var(--text-secondary);
    font-style: italic;
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
