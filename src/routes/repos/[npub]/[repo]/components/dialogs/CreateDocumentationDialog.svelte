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

<Modal {open} title="Create Documentation Event" ariaLabel="Create documentation event" {onClose} maxWidth="800px">
  {#snippet children()}
    <p class="description">
      Create a documentation event. This will be published to Nostr relays.
    </p>
    <label>
      Event Kind:
      <select bind:value={state.forms.documentation.kind}>
        <option value={30818}>30818 - Repository State (Asciidoc)</option>
        <option value={30041}>30041 - Publication (Asciidoc)</option>
        <option value={30817}>30817 - Repository Announcement</option>
        <option value={30023}>30023 - Article</option>
      </select>
      <small>Select the type of documentation event to create</small>
    </label>
    <label>
      Title:
      <input type="text" bind:value={state.forms.documentation.title} placeholder="Documentation Title" />
    </label>
    <label>
      Identifier (d-tag):
      <input type="text" bind:value={state.forms.documentation.identifier} placeholder="e.g., nkbip-01" />
      <small>Unique identifier for this documentation event</small>
    </label>
    <label>
      Subject:
      <textarea bind:value={state.forms.documentation.content} rows="15" placeholder="Content here..."></textarea>
    </label>
    <div class="modal-actions">
      <button onclick={onClose} class="cancel-button">Cancel</button>
      <button 
        onclick={onCreate} 
        disabled={!state.forms.documentation.title.trim() || !state.forms.documentation.identifier.trim() || !state.forms.documentation.content.trim() || state.saving} 
        class="save-button"
      >
        {state.saving ? 'Creating...' : 'Create'}
      </button>
    </div>
  {/snippet}
</Modal>

<style>
  .description {
    margin-bottom: 1rem;
    color: var(--text-secondary);
    font-size: 0.9rem;
  }

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
    font-family: inherit;
  }

  label textarea {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 0.9rem;
  }

  label small {
    display: block;
    margin-top: 0.25rem;
    color: var(--text-secondary);
    font-size: 0.85rem;
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
